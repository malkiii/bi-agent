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
  type Column,
  type ConnectionTestResult,
  type DataSourceDriver,
  type DriverContext,
  type DriverRegistry,
  type IntrospectedDataset,
} from './driver';

/** What an admin wrote about a Dataset or column. Both are left out when empty. */
export interface CatalogDetails {
  description?: string;
  /** Business terms that mean this Dataset or column, e.g. "revenue" for `orders.total_amount`. */
  synonyms?: string[];
}

export interface CatalogColumn extends Column, CatalogDetails {}

export interface CatalogDataset extends Omit<IntrospectedDataset, 'columns'>, CatalogDetails {
  columns: CatalogColumn[];
  /** Only Exposed Datasets are visible to the agent. */
  exposed: boolean;
}

/** Everything an admin writes about one Dataset; replaces what was there (left out = cleared). */
export interface DatasetDetailsInput {
  description?: string;
  synonyms?: readonly string[];
  /** By column name. */
  columns?: Readonly<Record<string, { description?: string; synonyms?: readonly string[] }>>;
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
  /**
   * Introspects and stores the Datasets, keeping existing exposure choices, Dataset
   * descriptions and Synonyms, and those of columns whose name and type are unchanged.
   */
  refreshSchema(actorSlackUserId: string, id: string): Promise<DataSourceView>;
  /** Admin only: sets the descriptions and Synonyms of a Dataset and its columns. */
  updateDatasetDetails(
    actorSlackUserId: string,
    id: string,
    datasetId: string,
    details: DatasetDetailsInput,
  ): Promise<DataSourceView>;
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

export function createDataSources({ db, clock, users, drivers, secretBox }: Deps): DataSources {
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
      if (kind.managed) throw managedError(kind.label, { kind: 'Managed by Botley' });
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
      if (input.kind !== existing.kind) {
        throw new ValidationError('The kind of a Data Source cannot change.', { kind: 'Cannot change' });
      }
      const kind = kindOf(existing.kind);
      if (kind.managed || existing.createdBy === MANAGED_BY) throw managedError(kind.label);
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
      // Checked on the document too, so it holds even when the kind is not registered.
      if (existing.createdBy === MANAGED_BY || drivers[existing.kind]?.managed) throw managedError(existing.name);
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
      const doc = await load(id);
      const introspected = await withDriverFor(
        kindOf(doc.kind),
        doc.config,
        openSecrets(doc),
        (driver) => driver.introspect(),
        doc._id,
      );
      const previous = new Map(doc.datasets.map((d) => [d.id, d]));
      const datasets = introspected.map((d) => mergeCatalogDataset(previous.get(d.id), d));
      const now = clock.now();
      return save(id, { datasets, schemaRefreshedAt: now, updatedAt: now, updatedBy: actor });
    },

    async updateDatasetDetails(actor, id, datasetId, details) {
      await users.requireAdmin(actor);
      const doc = await load(id);
      const dataset = doc.datasets.find((d) => d.id === datasetId);
      if (!dataset) throw new ValidationError(`Unknown Dataset "${datasetId}". Refresh the schema first.`);
      const columnDetails = details.columns ?? {};
      const unknown = Object.keys(columnDetails).filter((name) => !dataset.columns.some((c) => c.name === name));
      if (unknown.length > 0) throw new ValidationError(`${datasetId} has no columns named ${unknown.join(', ')}.`);

      const updated: CatalogDataset = {
        ...withDetails(dataset, details),
        columns: dataset.columns.map((c) => withDetails(c, columnDetails[c.name] ?? {})),
      };
      const datasets = doc.datasets.map((d) => (d.id === datasetId ? updated : d));
      return save(id, { datasets, updatedAt: clock.now(), updatedBy: actor });
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

/** Trimmed, without blanks or case-insensitive repeats (the first spelling wins). */
function cleanSynonyms(synonyms: readonly string[] = []): string[] {
  const seen = new Set<string>();
  return synonyms.flatMap((s) => {
    const term = typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : '';
    if (!term || seen.has(term.toLowerCase())) return [];
    seen.add(term.toLowerCase());
    return [term];
  });
}

/** `target` with its description and Synonyms replaced by `details`; empty ones are left out. */
function withDetails<T extends object>(target: T, details: CatalogDetails | DatasetDetailsInput): T & CatalogDetails {
  const rest: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  delete rest.description;
  delete rest.synonyms;
  const description = typeof details.description === 'string' ? details.description.trim() : '';
  const synonyms = cleanSynonyms(details.synonyms);
  return {
    ...rest,
    ...(description && { description }),
    ...(synonyms.length > 0 && { synonyms }),
  } as T & CatalogDetails;
}

/**
 * A freshly introspected (or re-uploaded) Dataset, keeping what the catalog knew about it:
 * exposure, the Dataset's description and Synonyms, and those of columns with the same name and type.
 */
export function mergeCatalogDataset(
  previous: CatalogDataset | undefined,
  next: Omit<IntrospectedDataset, 'columns'> & { columns: Column[] },
  options: { exposedByDefault?: boolean } = {},
): CatalogDataset {
  const columns = next.columns.map((column) => {
    const before = previous?.columns.find((c) => c.name === column.name && c.type === column.type);
    return before ? withDetails(column, before) : column;
  });
  return {
    ...withDetails(next, previous ?? {}),
    columns,
    exposed: previous?.exposed ?? options.exposedByDefault ?? false,
  };
}

/** The actor recorded on Data Sources the App Core maintains itself. */
const MANAGED_BY = 'botley';

function managedError(label: string, fieldErrors?: Record<string, string>) {
  return new ValidationError(
    `The ${label} Data Source is maintained by Botley and cannot be added, edited or deleted here.`,
    fieldErrors,
  );
}

/**
 * For App Core modules that maintain a managed Data Source (Uploads): find or create it and
 * keep its Datasets. No actor checks; the calling module decides who may do what.
 */
export interface ManagedDataSources {
  /** The one Data Source of `kind`, created (named `name`) on first use. */
  ensure(kind: string, name: string): Promise<DataSourceView>;
  /** The Data Source of `kind`, or null before its first use. */
  find(kind: string): Promise<DataSourceView | null>;
  /** Adds the Dataset, or replaces the one with the same id. */
  putDataset(dataSourceId: string, dataset: CatalogDataset): Promise<void>;
  removeDataset(dataSourceId: string, datasetId: string): Promise<void>;
}

export function createManagedDataSources({ db, clock, secretBox }: Pick<Deps, 'db' | 'clock' | 'secretBox'>): ManagedDataSources {
  const collection = db.collection<DataSourceDoc>('dataSources');

  const view = (doc: DataSourceDoc): DataSourceView => ({
    id: doc._id,
    name: doc.name,
    kind: doc.kind,
    config: doc.config,
    secrets: {},
    datasets: doc.datasets,
    schemaRefreshedAt: doc.schemaRefreshedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });

  const touched = () => ({ updatedAt: clock.now(), updatedBy: MANAGED_BY, schemaRefreshedAt: clock.now() });

  return {
    async ensure(kind, name) {
      const existing = await collection.findOne({ kind });
      if (existing) return view(existing);
      const now = clock.now();
      const doc: DataSourceDoc = {
        _id: randomUUID(),
        name,
        kind,
        config: {},
        sealedSecrets: secretBox.seal('{}'),
        datasets: [],
        schemaRefreshedAt: now,
        createdAt: now,
        createdBy: MANAGED_BY,
        updatedAt: now,
        updatedBy: MANAGED_BY,
      };
      try {
        await collection.insertOne(doc);
        return view(doc);
      } catch (error) {
        // Created concurrently: use that one.
        const raced = await collection.findOne({ kind });
        if (raced) return view(raced);
        if (error instanceof MongoServerError && error.code === 11000) {
          throw new ValidationError(`Rename the Data Source "${name}": Botley needs that name for its ${kind} Data Source.`);
        }
        throw error;
      }
    },

    async find(kind) {
      const doc = await collection.findOne({ kind });
      return doc ? view(doc) : null;
    },

    async putDataset(dataSourceId, dataset) {
      const replaced = await collection.updateOne(
        { _id: dataSourceId, 'datasets.id': dataset.id },
        { $set: { 'datasets.$': dataset, ...touched() } },
      );
      if (replaced.matchedCount > 0) return;
      const added = await collection.updateOne(
        { _id: dataSourceId, 'datasets.id': { $ne: dataset.id } },
        { $push: { datasets: dataset }, $set: touched() },
      );
      if (added.matchedCount === 0) throw new NotFoundError('Data Source not found.');
    },

    async removeDataset(dataSourceId, datasetId) {
      await collection.updateOne({ _id: dataSourceId }, { $pull: { datasets: { id: datasetId } }, $set: touched() });
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
