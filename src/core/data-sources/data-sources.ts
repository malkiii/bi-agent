/**
 * Data Source management: create/edit/delete (admins), test connection, introspect and
 * choose Exposed Datasets. Secrets are sealed with AES-256-GCM and never leave this module
 * except inside a driver (`withDriver`).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { MongoServerError, type Db } from 'mongodb';
import type { z } from 'zod';
import { NotFoundError, ValidationError } from '../errors';
import type { Clock } from '../ports';
import type { SealedSecret, SecretBox } from '../secret-box';
import type { Users } from '../users/users';
import {
  OAuthError,
  type AnyDriverKind,
  type ConnectionTestResult,
  type DataSourceDriver,
  type DriverContext,
  type DriverRegistry,
  type IntrospectedDataset,
} from './driver';

export interface CatalogDataset extends IntrospectedDataset {
  /** Only Exposed Datasets are visible to the agent. */
  exposed: boolean;
}

/** A Data Source as clients see it: secrets are reduced to "set" indicators. */
export interface DataSourceView {
  id: string;
  name: string;
  kind: string;
  config: Record<string, unknown>;
  /** For each secret field of the kind: whether a value is stored. */
  secrets: Record<string, boolean>;
  datasets: CatalogDataset[];
  schemaRefreshedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Only for OAuth kinds (Salesforce): whether the consent flow has stored tokens. */
  connected?: boolean;
}

export interface DataSourceInput {
  name: string;
  kind: string;
  config: Record<string, unknown>;
  /** Secret field values. On update and test, a missing or empty value keeps the stored one. */
  secrets: Record<string, string | undefined>;
}

export interface ConnectionTestInput extends DataSourceInput {
  /** Fill missing secrets from this saved Data Source (testing an edit without retyping the password). */
  id?: string;
}

export interface DataSources {
  list(): Promise<DataSourceView[]>;
  get(id: string): Promise<DataSourceView>;
  create(actorSlackUserId: string, input: DataSourceInput): Promise<DataSourceView>;
  update(actorSlackUserId: string, id: string, input: DataSourceInput): Promise<DataSourceView>;
  delete(actorSlackUserId: string, id: string): Promise<void>;
  testConnection(actorSlackUserId: string, input: ConnectionTestInput): Promise<ConnectionTestResult>;
  /** Introspects and stores the Datasets, keeping existing exposure choices. */
  refreshSchema(actorSlackUserId: string, id: string): Promise<DataSourceView>;
  /** Exactly these Dataset ids become exposed; the rest are hidden. */
  setExposedDatasets(actorSlackUserId: string, id: string, datasetIds: readonly string[]): Promise<DataSourceView>;
  /** Opens the Data Source's driver with decrypted credentials, runs `work`, then closes it. */
  withDriver<T>(id: string, work: (driver: DataSourceDriver) => Promise<T>): Promise<T>;
  /**
   * OAuth kinds: starts the consent flow (authorization code + PKCE) and returns the provider
   * URL to send the admin's browser to. `redirectUri` is the absolute callback URL.
   */
  startOAuth(actorSlackUserId: string, id: string, request: { redirectUri: string }): Promise<{ url: string }>;
  /**
   * Finishes the consent flow from the callback's query parameters: exchanges the code and
   * stores the tokens sealed. Throws OAuthError (carrying the Data Source id when known).
   */
  completeOAuth(
    actorSlackUserId: string,
    callback: { state: string; code?: string; error?: string; errorDescription?: string },
  ): Promise<DataSourceView>;
}

/** App Core-only operations, used by modules that manage a Data Source themselves (Uploads). */
export interface DataSourcesInternal extends DataSources {
  /** Creates a managed Data Source with a fixed id if missing; keeps its config current. */
  ensureManaged(input: { id: string; name: string; kind: string; config: Record<string, unknown> }): Promise<DataSourceView>;
  /** Introspects and stores the Datasets, keeping exposure choices and exposing `expose` ids. */
  syncSchema(id: string, actorSlackUserId: string, expose: readonly string[]): Promise<DataSourceView>;
}

/** OAuth flows not yet completed; expire after OAUTH_STATE_TTL_MS. */
interface OAuthStateDoc {
  _id: string;
  dataSourceId: string;
  actor: string;
  codeVerifier: string;
  redirectUri: string;
  expiresAt: Date;
}

const OAUTH_STATE_TTL_MS = 10 * 60_000;

interface DataSourceDoc {
  _id: string;
  name: string;
  kind: string;
  config: Record<string, unknown>;
  sealedSecrets: SealedSecret;
  datasets: CatalogDataset[];
  schemaRefreshedAt: Date | null;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
}

interface Deps {
  db: Db;
  clock: Clock;
  users: Users;
  drivers: DriverRegistry;
  secretBox: SecretBox;
}

export function createDataSources({ db, clock, users, drivers, secretBox }: Deps): DataSourcesInternal {
  const collection = db.collection<DataSourceDoc>('dataSources');
  const oauthStates = db.collection<OAuthStateDoc>('oauthStates');

  function kindOf(kind: string): AnyDriverKind {
    const found = Object.hasOwn(drivers, kind) ? drivers[kind] : undefined;
    if (!found) throw new ValidationError(`Unknown Data Source kind "${kind}".`, { kind: 'Unknown kind' });
    return found;
  }

  function secretKeys(kind: AnyDriverKind): string[] {
    return kind.fields.filter((f) => f.secret).map((f) => f.key);
  }

  function openSecrets(doc: DataSourceDoc): Record<string, string> {
    return JSON.parse(secretBox.open(doc.sealedSecrets)) as Record<string, string>;
  }

  function toView(doc: DataSourceDoc): DataSourceView {
    const stored = openSecrets(doc);
    const kind = drivers[doc.kind];
    const keys = kind ? secretKeys(kind) : Object.keys(stored);
    return {
      id: doc._id,
      name: doc.name,
      kind: doc.kind,
      config: doc.config,
      secrets: Object.fromEntries(keys.map((k) => [k, Boolean(stored[k])])),
      datasets: doc.datasets,
      schemaRefreshedAt: doc.schemaRefreshedAt,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      ...(kind?.oauth ? { connected: kind.oauth.isConnected(stored) } : {}),
    };
  }

  /** Lets a driver persist secrets it changed (refreshed OAuth tokens) into the saved Data Source. */
  function contextFor(id: string): DriverContext {
    return {
      async saveSecrets(update) {
        const doc = await collection.findOne({ _id: id });
        if (!doc) return;
        const merged = { ...openSecrets(doc), ...withoutUndefined(update) };
        await collection.updateOne({ _id: id }, { $set: { sealedSecrets: secretBox.seal(JSON.stringify(merged)) } });
      },
    };
  }

  async function load(id: string): Promise<DataSourceDoc> {
    const doc = await collection.findOne({ _id: id });
    if (!doc) throw new NotFoundError('Data Source not found.');
    return doc;
  }

  /** Validates the input against its kind; `storedSecrets` fill in blank secret fields. */
  function validate(input: DataSourceInput, storedSecrets: Record<string, string> = {}) {
    const kind = kindOf(input.kind);
    const fieldErrors: Record<string, string> = {};
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) fieldErrors.name = 'Name is required';

    const provided = Object.fromEntries(
      Object.entries(input.secrets ?? {}).filter(([k, v]) => secretKeys(kind).includes(k) && v),
    );
    const config = collect(kind.configSchema, input.config ?? {}, fieldErrors);
    const secrets = collect(kind.secretsSchema, { ...storedSecrets, ...provided }, fieldErrors);

    if (Object.keys(fieldErrors).length > 0 || config === undefined || secrets === undefined) {
      throw new ValidationError('Some settings are missing or invalid.', fieldErrors);
    }
    return { kind, name, config: config as Record<string, unknown>, secrets: secrets as Record<string, string> };
  }

  async function withDriverFor<T>(
    kind: AnyDriverKind,
    config: unknown,
    secrets: unknown,
    work: (driver: DataSourceDriver) => Promise<T>,
    savedId?: string,
  ): Promise<T> {
    const driver = kind.create(config, secrets, savedId ? contextFor(savedId) : undefined);
    try {
      return await work(driver);
    } finally {
      await driver.close();
    }
  }

  function refuseManaged(kind: AnyDriverKind): void {
    if (kind.managed) {
      throw new ValidationError(`The ${kind.label} Data Source is built in; it cannot be added, edited or deleted here.`);
    }
  }

  async function syncSchema(id: string, actor: string, expose: readonly string[]): Promise<DataSourceView> {
    const doc = await load(id);
    const introspected = await withDriverFor(
      kindOf(doc.kind),
      doc.config,
      openSecrets(doc),
      (driver) => driver.introspect(),
      doc._id,
    );
    const exposed = new Set([...doc.datasets.filter((d) => d.exposed).map((d) => d.id), ...expose]);
    const datasets = introspected.map((d) => ({ ...d, exposed: exposed.has(d.id) }));
    const now = clock.now();
    return save(id, { datasets, schemaRefreshedAt: now, updatedAt: now, updatedBy: actor });
  }

  async function save(id: string, update: Partial<DataSourceDoc>): Promise<DataSourceView> {
    try {
      const doc = await collection.findOneAndUpdate({ _id: id }, { $set: update }, { returnDocument: 'after' });
      if (!doc) throw new NotFoundError('Data Source not found.');
      return toView(doc);
    } catch (error) {
      throw duplicateName(error);
    }
  }

  return {
    async list() {
      const docs = await collection.find().sort({ name: 1 }).toArray();
      return docs.map(toView);
    },

    async get(id) {
      return toView(await load(id));
    },

    async create(actor, input) {
      await users.requireAdmin(actor);
      const { name, kind, config, secrets } = validate(input);
      refuseManaged(kind);
      const now = clock.now();
      const doc: DataSourceDoc = {
        _id: randomUUID(),
        name,
        kind: kind.kind,
        config,
        sealedSecrets: secretBox.seal(JSON.stringify(secrets)),
        datasets: [],
        schemaRefreshedAt: null,
        createdAt: now,
        createdBy: actor,
        updatedAt: now,
        updatedBy: actor,
      };
      try {
        await collection.insertOne(doc);
      } catch (error) {
        throw duplicateName(error);
      }
      return toView(doc);
    },

    async update(actor, id, input) {
      await users.requireAdmin(actor);
      const existing = await load(id);
      refuseManaged(kindOf(existing.kind));
      if (input.kind !== existing.kind) {
        throw new ValidationError('The kind of a Data Source cannot change.', { kind: 'Cannot change' });
      }
      const kind = kindOf(existing.kind);
      let stored = openSecrets(existing);
      // OAuth tokens belong to the org and app in the config: changing it needs a reconnect.
      if (kind.oauth && JSON.stringify(validate(input, stored).config) !== JSON.stringify(existing.config)) {
        stored = Object.fromEntries(Object.entries(stored).filter(([k]) => secretKeys(kind).includes(k)));
      }
      const { name, config, secrets } = validate(input, stored);
      return save(id, {
        name,
        config,
        sealedSecrets: secretBox.seal(JSON.stringify(secrets)),
        updatedAt: clock.now(),
        updatedBy: actor,
      });
    },

    async delete(actor, id) {
      await users.requireAdmin(actor);
      const existing = await load(id);
      if (drivers[existing.kind]) refuseManaged(kindOf(existing.kind));
      const { deletedCount } = await collection.deleteOne({ _id: id });
      if (deletedCount === 0) throw new NotFoundError('Data Source not found.');
    },

    async testConnection(actor, input) {
      await users.requireAdmin(actor);
      const stored = input.id ? openSecrets(await load(input.id)) : {};
      const { kind, config, secrets } = validate({ ...input, name: input.name || 'untitled' }, stored);
      return withDriverFor(kind, config, secrets, (driver) => driver.testConnection(), input.id);
    },

    async refreshSchema(actor, id) {
      await users.requireAdmin(actor);
      return syncSchema(id, actor, []);
    },

    async setExposedDatasets(actor, id, datasetIds) {
      await users.requireAdmin(actor);
      const doc = await load(id);
      const known = new Set(doc.datasets.map((d) => d.id));
      const unknown = datasetIds.filter((d) => !known.has(d));
      if (unknown.length > 0) {
        throw new ValidationError(`Unknown Datasets: ${unknown.join(', ')}. Refresh the schema first.`);
      }
      const chosen = new Set(datasetIds);
      const datasets = doc.datasets.map((d) => ({ ...d, exposed: chosen.has(d.id) }));
      return save(id, { datasets, updatedAt: clock.now(), updatedBy: actor });
    },

    syncSchema,

    async ensureManaged({ id, name, kind, config }) {
      kindOf(kind);
      const now = clock.now();
      const insert = (displayName: string) =>
        collection.updateOne(
          { _id: id },
          {
            $set: { config },
            $setOnInsert: {
              name: displayName,
              kind,
              sealedSecrets: secretBox.seal('{}'),
              datasets: [],
              schemaRefreshedAt: null,
              createdAt: now,
              createdBy: 'system',
              updatedAt: now,
              updatedBy: 'system',
            },
          },
          { upsert: true },
        );
      try {
        await insert(name);
      } catch (error) {
        // An admin already named another Data Source like this one.
        if (!(error instanceof MongoServerError && error.code === 11000)) throw error;
        await insert(`${name} (built in)`);
      }
      return toView(await load(id));
    },

    async withDriver(id, work) {
      const doc = await load(id);
      return withDriverFor(kindOf(doc.kind), doc.config, openSecrets(doc), work, doc._id);
    },

    async startOAuth(actor, id, { redirectUri }) {
      await users.requireAdmin(actor);
      const doc = await load(id);
      const kind = kindOf(doc.kind);
      if (!kind.oauth) throw new ValidationError(`${kind.label} Data Sources do not connect through OAuth.`);
      const state = randomBytes(24).toString('base64url');
      const codeVerifier = randomBytes(32).toString('base64url');
      const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
      await oauthStates.insertOne({
        _id: state,
        dataSourceId: id,
        actor,
        codeVerifier,
        redirectUri,
        expiresAt: new Date(clock.now().getTime() + OAUTH_STATE_TTL_MS),
      });
      return { url: kind.oauth.authorizationUrl(doc.config, { redirectUri, state, codeChallenge }) };
    },

    async completeOAuth(actor, { state, code, error, errorDescription }) {
      await users.requireAdmin(actor);
      const pending = state ? await oauthStates.findOneAndDelete({ _id: state }) : null;
      if (!pending || pending.expiresAt <= clock.now() || pending.actor !== actor) {
        throw new OAuthError(
          'This connect attempt has expired or was started by someone else. Start it again.',
          pending?.dataSourceId,
        );
      }
      const id = pending.dataSourceId;
      if (error || !code) {
        throw new OAuthError(`The connection was not approved (${errorDescription || error || 'no code returned'}).`, id);
      }
      const doc = await load(id);
      const kind = kindOf(doc.kind);
      if (!kind.oauth) throw new OAuthError(`${kind.label} Data Sources do not connect through OAuth.`, id);
      const stored = openSecrets(doc);
      let tokens: Record<string, unknown>;
      try {
        tokens = await kind.oauth.exchangeCode(doc.config, stored, {
          code,
          codeVerifier: pending.codeVerifier,
          redirectUri: pending.redirectUri,
        });
      } catch (e) {
        throw new OAuthError(e instanceof Error ? e.message : String(e), id);
      }
      return save(id, {
        sealedSecrets: secretBox.seal(JSON.stringify({ ...stored, ...withoutUndefined(tokens) })),
        updatedAt: clock.now(),
        updatedBy: actor,
      });
    },
  };
}

function withoutUndefined(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
}

/** Parses `value`, recording the first message per top-level field. */
function collect(schema: z.ZodType, value: unknown, fieldErrors: Record<string, string>): unknown {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? '_');
    fieldErrors[key] ??= issue.message;
  }
  return undefined;
}

function duplicateName(error: unknown): unknown {
  if (error instanceof MongoServerError && error.code === 11000) {
    return new ValidationError('A Data Source with this name already exists.', { name: 'Already in use' });
  }
  return error;
}

export async function ensureDataSourceIndexes(db: Db) {
  await db.collection('dataSources').createIndex({ name: 1 }, { unique: true });
  await db.collection('oauthStates').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}
