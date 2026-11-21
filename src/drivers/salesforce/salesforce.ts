/**
 * Salesforce driver: SOQL over the REST API as the OAuth integration user.
 *
 * Read-only by construction: the driver only ever sends GET requests to the query, sobjects
 * and describe endpoints, and `assertReadOnlySoql` refuses anything but one SELECT (and the
 * clauses that write view/reference stats or lock records) before a request is made.
 *
 * Tokens: the admin connects with the OAuth web-server flow + PKCE (`salesforceKind.oauth`).
 * The refresh token, the latest access token and the instance URL are stored as sealed
 * secrets. On a 401 the driver refreshes once and reports the new tokens through
 * `onTokens`, which the App Core persists back to the Data Source.
 */
import { z } from 'zod';
import {
  DEFAULT_QUERY_LIMITS,
  OAuthError,
  QueryFailedError,
  QueryRejectedError,
  QueryTimeoutError,
  type Column,
  type ColumnType,
  type DataSourceDriver,
  type Dialect,
  type DriverKind,
  type IntrospectedDataset,
  type ResultColumn,
} from '@/core/data-sources/driver';

export const SALESFORCE_API_VERSION = 'v68.0';

export interface SalesforceTokens {
  accessToken?: string;
  refreshToken?: string;
  instanceUrl?: string;
}

export interface SalesforceConnection extends SalesforceTokens {
  /** `https://login.salesforce.com`, `https://test.salesforce.com` or the org's My Domain URL. */
  loginUrl: string;
  clientId: string;
  clientSecret: string;
  apiVersion: string;
}

export interface SalesforceDriverOptions {
  /** Called with fresh tokens after a refresh, so they can be stored. */
  onTokens?(tokens: SalesforceTokens): Promise<void> | void;
}

export const SALESFORCE_DIALECT: Dialect = {
  language: 'soql',
  flavour: 'salesforce',
  guidance:
    'Salesforce SOQL. Write one SELECT, no semicolon. There is no SELECT * (name the fields, or FIELDS(STANDARD)) ' +
    'and no JOIN: follow relationships with dot paths (Account.Name) or child subqueries ' +
    '(SELECT Id, (SELECT Id FROM Contacts) FROM Account). Aggregate with GROUP BY and alias every aggregate ' +
    '(SUM(Amount) total). Use date literals such as THIS_QUARTER or LAST_N_DAYS:30. Strings use single quotes.',
};

// ---------------------------------------------------------------------------------------------
// Read-only guard

/** Replaces string literals with blanks so keywords inside them are ignored. */
function stripStrings(soql: string): string {
  return soql.replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

const WRITE_SIDE_EFFECTS: [RegExp, string][] = [
  [/\bFOR\s+UPDATE\b/i, 'FOR UPDATE locks records'],
  [/\bFOR\s+VIEW\b/i, 'FOR VIEW updates LastViewedDate'],
  [/\bFOR\s+REFERENCE\b/i, 'FOR REFERENCE updates LastReferencedDate'],
  [/\bUPDATE\s+(TRACKING|VIEWSTAT)\b/i, 'UPDATE TRACKING/VIEWSTAT writes statistics'],
];

/** Returns the trimmed SOQL, or throws QueryRejectedError unless it is one read-only SELECT. */
export function assertReadOnlySoql(query: unknown): string {
  if (typeof query !== 'string') throw new QueryRejectedError('Salesforce Data Sources take a SOQL string.');
  const soql = query.trim();
  if (!soql) throw new QueryRejectedError('The query is empty.');
  const bare = stripStrings(soql);
  if (/'/.test(bare.replace(/''/g, ''))) throw new QueryRejectedError('The query has an unterminated string.');
  if (!/^SELECT\s/i.test(bare)) throw new QueryRejectedError('Only a single SOQL SELECT query is allowed.');
  if (bare.includes(';')) throw new QueryRejectedError('Only one SOQL query is allowed: remove the semicolon.');
  for (const [pattern, reason] of WRITE_SIDE_EFFECTS) {
    if (pattern.test(bare)) throw new QueryRejectedError(`Not allowed: ${reason}.`);
  }
  return soql;
}

// ---------------------------------------------------------------------------------------------
// Types

const FIELD_TYPES: Record<string, ColumnType> = {
  id: 'string',
  string: 'string',
  textarea: 'string',
  picklist: 'string',
  multipicklist: 'string',
  combobox: 'string',
  reference: 'string',
  phone: 'string',
  email: 'string',
  url: 'string',
  encryptedstring: 'string',
  int: 'integer',
  long: 'integer',
  double: 'number',
  currency: 'number',
  percent: 'number',
  boolean: 'boolean',
  date: 'date',
  datetime: 'datetime',
  address: 'json',
  location: 'json',
};

interface DescribeField {
  name: string;
  type: string;
  nillable: boolean;
  length?: number;
  referenceTo?: string[];
}

function nativeType(f: DescribeField): string {
  if (f.type === 'reference' && f.referenceTo?.length) return `reference(${f.referenceTo.join(',')})`;
  if (['string', 'textarea', 'picklist', 'encryptedstring'].includes(f.type) && f.length) return `${f.type}(${f.length})`;
  return f.type;
}

/** Objects that are queryable but only noise for a BI agent. */
const NOISE = /(History|Share|Feed|ChangeEvent|__Tag|__hd)$/;

function valueType(value: unknown): ColumnType | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(value)) return 'datetime';
    return 'string';
  }
  return 'json';
}

const NUMERIC = new Set<ColumnType>(['integer', 'number']);
const TEXTUAL = new Set<ColumnType>(['string', 'date', 'datetime']);

/**
 * The column type that fits every value (SOQL results carry no column metadata): integers
 * widen to numbers, mixed text/dates become strings, any other mix is `other`.
 */
function columnType(values: unknown[]): ColumnType {
  let type: ColumnType | null = null;
  for (const value of values) {
    const t = valueType(value);
    if (t === null || t === type) continue;
    if (type === null) type = t;
    else if (NUMERIC.has(type) && NUMERIC.has(t)) type = 'number';
    else if (TEXTUAL.has(type) && TEXTUAL.has(t)) type = 'string';
    else return 'other';
  }
  return type ?? 'other';
}

type SfRecord = Record<string, unknown>;

/** Strips `attributes`, turns parent relationships into dot paths and child subqueries into JSON arrays. */
function flatten(record: SfRecord, prefix = '', out: SfRecord = {}): SfRecord {
  for (const [key, value] of Object.entries(record)) {
    if (key === 'attributes') continue;
    const name = prefix + key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const v = value as SfRecord;
      if (Array.isArray(v.records)) out[name] = (v.records as SfRecord[]).map((r) => flatten(r));
      else if ('attributes' in v) flatten(v, `${name}.`, out);
      else out[name] = value;
    } else {
      out[name] = value;
    }
  }
  return out;
}

/** The top-level SELECT list, for naming columns of an empty result. */
function selectList(soql: string): string[] {
  const bare = stripStrings(soql).replace(/^SELECT\s+/i, '');
  const items: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < bare.length; i++) {
    const ch = bare[i]!;
    if (depth === 0 && /^\sFROM\s/i.test(bare.slice(i, i + 6))) break;
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) items.push(current.trim());
  let expr = 0;
  return items
    .filter((item) => !/^\(\s*SELECT\s/i.test(item))
    .map((item) => {
      const alias = item.match(/\)\s+([A-Za-z_]\w*)$/);
      if (alias) return alias[1]!;
      return item.includes('(') ? `expr${expr++}` : item;
    });
}

// ---------------------------------------------------------------------------------------------
// HTTP

class AuthRefusedError extends Error {}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  instance_url: string;
}

async function postToken(loginUrl: string, form: Record<string, string>, signal?: AbortSignal): Promise<OAuthTokenResponse> {
  const res = await fetch(new URL('/services/oauth2/token', loginUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form),
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as Partial<OAuthTokenResponse> & {
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token || !body.instance_url) {
    const detail = [body.error, body.error_description].filter(Boolean).join(': ') || `HTTP ${res.status}`;
    throw new AuthRefusedError(detail);
  }
  return body as OAuthTokenResponse;
}

function sfErrorMessage(status: number, body: unknown): string {
  if (Array.isArray(body) && body.length > 0) {
    return body
      .map((e: { errorCode?: string; message?: string }) => [e.errorCode, e.message].filter(Boolean).join(': '))
      .join('; ');
  }
  return `Salesforce answered HTTP ${status}.`;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

const NOT_CONNECTED = 'Not connected to Salesforce yet. Save this Data Source, then use "Connect to Salesforce".';

export function createSalesforceDriver(
  connection: SalesforceConnection,
  options: SalesforceDriverOptions = {},
): DataSourceDriver {
  const tokens: SalesforceTokens = {
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    instanceUrl: connection.instanceUrl,
  };
  const base = () => `/services/data/${connection.apiVersion}`;
  let refreshing: Promise<void> | null = null;
  const inFlight = new Set<AbortController>();

  async function refresh(signal?: AbortSignal) {
    if (!tokens.refreshToken) throw new AuthRefusedError(NOT_CONNECTED);
    const res = await postToken(
      connection.loginUrl,
      {
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
        client_id: connection.clientId,
        client_secret: connection.clientSecret,
      },
      signal,
    );
    tokens.accessToken = res.access_token;
    tokens.instanceUrl = res.instance_url;
    if (res.refresh_token) tokens.refreshToken = res.refresh_token;
    await options.onTokens?.({ ...tokens });
  }

  /** Refreshes once even when several requests hit a 401 together. */
  function refreshOnce(signal?: AbortSignal): Promise<void> {
    refreshing ??= refresh(signal).finally(() => (refreshing = null));
    return refreshing;
  }

  /** GET `path` on the instance as JSON; refreshes the access token once on 401. */
  async function get<T>(path: string, signal: AbortSignal): Promise<T> {
    if (!tokens.refreshToken && !tokens.accessToken) throw new AuthRefusedError(NOT_CONNECTED);
    if (!tokens.accessToken || !tokens.instanceUrl) await refreshOnce(signal);
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(new URL(path, tokens.instanceUrl), {
        headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: 'application/json' },
        signal,
      });
      if (res.status === 401 && attempt === 0) {
        await res.body?.cancel();
        await refreshOnce(signal);
        continue;
      }
      const body = (await res.json().catch(() => null)) as unknown;
      if (res.status === 401) throw new AuthRefusedError(sfErrorMessage(res.status, body));
      if (!res.ok) throw new QueryFailedError(sfErrorMessage(res.status, body));
      return body as T;
    }
  }

  function readable(error: unknown): string {
    if (error instanceof AuthRefusedError) {
      return error.message === NOT_CONNECTED
        ? NOT_CONNECTED
        : `Salesforce refused the stored login (${error.message}). Reconnect the Data Source.`;
    }
    if (error instanceof QueryFailedError) return error.message;
    const cause = (error as { cause?: { code?: string } }).cause;
    if (cause?.code === 'ECONNREFUSED') return `Could not connect to Salesforce at ${tokens.instanceUrl ?? connection.loginUrl}.`;
    if (cause?.code === 'ENOTFOUND') return `Could not find the Salesforce host ${tokens.instanceUrl ?? connection.loginUrl}.`;
    return error instanceof Error ? error.message : String(error);
  }

  /** Runs `work` with an abort signal that fires after `timeoutMs` or on close. */
  async function withTimeout<T>(timeoutMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    inFlight.add(controller);
    const timer = setTimeout(() => controller.abort(new QueryTimeoutError(timeoutMs)), timeoutMs);
    try {
      return await work(controller.signal);
    } catch (error) {
      if (controller.signal.aborted && (isAbort(error) || error instanceof QueryTimeoutError)) {
        throw new QueryTimeoutError(timeoutMs);
      }
      if (error instanceof QueryFailedError || error instanceof QueryTimeoutError) throw error;
      throw new QueryFailedError(readable(error));
    } finally {
      clearTimeout(timer);
      inFlight.delete(controller);
    }
  }

  return {
    dialect: SALESFORCE_DIALECT,

    async testConnection() {
      try {
        await withTimeout(15_000, (signal) => get(`${base()}/`, signal));
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },

    async introspect() {
      return withTimeout(120_000, async (signal) => {
        const { sobjects } = await get<{ sobjects: { name: string; queryable: boolean; deprecatedAndHidden?: boolean }[] }>(
          `${base()}/sobjects`,
          signal,
        );
        const names = sobjects
          .filter((o) => o.queryable && !o.deprecatedAndHidden && !NOISE.test(o.name))
          .map((o) => o.name);
        const datasets: IntrospectedDataset[] = new Array(names.length);
        let next = 0;
        // A few describes at a time: each one counts against the org's daily API limit anyway.
        const workers = Array.from({ length: Math.min(6, names.length) }, async () => {
          while (next < names.length) {
            const index = next++;
            const name = names[index]!;
            const d = await get<{ name: string; fields: DescribeField[] }>(
              `${base()}/sobjects/${encodeURIComponent(name)}/describe`,
              signal,
            );
            const columns: Column[] = d.fields.map((f) => ({
              name: f.name,
              type: FIELD_TYPES[f.type] ?? 'other',
              nativeType: nativeType(f),
              nullable: f.nillable,
            }));
            datasets[index] = { id: d.name, name: d.name, schema: null, kind: 'object', columns };
          }
        });
        await Promise.all(workers);
        return datasets;
      });
    },

    async execute(query, limits) {
      const soql = assertReadOnlySoql(query);
      const { timeoutMs, maxRows } = { ...DEFAULT_QUERY_LIMITS, ...limits };
      const started = performance.now();

      return withTimeout(timeoutMs, async (signal) => {
        interface Page {
          totalSize: number;
          done: boolean;
          nextRecordsUrl?: string;
          records: SfRecord[];
        }
        let page = await get<Page>(`${base()}/query?q=${encodeURIComponent(soql)}`, signal);
        const records: SfRecord[] = [...page.records];
        while (!page.done && page.nextRecordsUrl && records.length <= maxRows) {
          page = await get<Page>(page.nextRecordsUrl, signal);
          records.push(...page.records);
        }
        const truncated = records.length > maxRows;
        const flat = records.slice(0, maxRows).map((r) => flatten(r));

        let columns: ResultColumn[];
        let rows: unknown[][];
        if (flat.length === 0 && /^SELECT\s+COUNT\(\s*\)\s+FROM\s/i.test(soql)) {
          columns = [{ name: 'count', type: 'integer' }];
          rows = [[page.totalSize]];
        } else {
          const names: string[] = [];
          const seen = new Set<string>();
          for (const r of flat) {
            for (const key of Object.keys(r)) {
              if (!seen.has(key)) {
                seen.add(key);
                names.push(key);
              }
            }
          }
          if (names.length === 0) names.push(...selectList(soql));
          rows = flat.map((r) => names.map((n) => r[n] ?? null));
          columns = names.map((name, i) => ({ name, type: columnType(rows.map((row) => row[i])) }));
        }
        return { columns, rows, truncated, durationMs: Math.round(performance.now() - started) };
      });
    },

    async close() {
      for (const controller of inFlight) controller.abort();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Kind

const salesforceConfigSchema = z.object({
  loginUrl: z
    .string()
    .trim()
    .url('Login URL must be a URL, e.g. https://login.salesforce.com')
    .refine((u) => /^https?:\/\//.test(u), 'Login URL must start with https://')
    .default('https://login.salesforce.com')
    .transform((u) => u.replace(/\/+$/, '')),
  clientId: z.string().trim().min(1, 'Consumer key is required'),
  apiVersion: z
    .string()
    .trim()
    .regex(/^v\d+\.\d$/, 'API version looks like v68.0')
    .default(SALESFORCE_API_VERSION),
});

const salesforceSecretsSchema = z.object({
  clientSecret: z.string({ error: 'Consumer secret is required' }).min(1, 'Consumer secret is required'),
  refreshToken: z.string().optional(),
  accessToken: z.string().optional(),
  instanceUrl: z.string().optional(),
});

type SalesforceConfig = z.infer<typeof salesforceConfigSchema>;
type SalesforceSecrets = z.infer<typeof salesforceSecretsSchema>;

export const salesforceKind: DriverKind<SalesforceConfig, SalesforceSecrets> = {
  kind: 'salesforce',
  label: 'Salesforce',
  fields: [
    {
      key: 'loginUrl',
      label: 'Login URL',
      input: 'text',
      required: true,
      defaultValue: 'https://login.salesforce.com',
      help: 'https://login.salesforce.com, https://test.salesforce.com for a sandbox, or your My Domain URL.',
    },
    {
      key: 'clientId',
      label: 'Consumer key',
      input: 'text',
      required: true,
      help:
        'From an External Client App with OAuth enabled, PKCE required, scopes "api refresh_token" and the ' +
        'callback URL <your BIBot URL>/api/admin/data-sources/oauth/callback. Connect as a read-only integration user.',
    },
    { key: 'clientSecret', label: 'Consumer secret', input: 'password', secret: true, required: true },
    { key: 'apiVersion', label: 'API version', input: 'text', defaultValue: SALESFORCE_API_VERSION },
  ],
  configSchema: salesforceConfigSchema,
  secretsSchema: salesforceSecretsSchema,
  create: (config, secrets, context) =>
    createSalesforceDriver(
      { ...config, ...secrets },
      { onTokens: context ? (tokens) => context.saveSecrets(tokens) : undefined },
    ),
  oauth: {
    providerLabel: 'Salesforce',
    authorizationUrl(config, { redirectUri, state, codeChallenge }) {
      const url = new URL('/services/oauth2/authorize', config.loginUrl);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: redirectUri,
        scope: 'api refresh_token',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        prompt: 'login consent',
      }).toString();
      return url.toString();
    },
    async exchangeCode(config, secrets, { code, codeVerifier, redirectUri }) {
      try {
        const res = await postToken(config.loginUrl, {
          grant_type: 'authorization_code',
          code,
          client_id: config.clientId,
          client_secret: secrets.clientSecret,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        });
        return { accessToken: res.access_token, refreshToken: res.refresh_token, instanceUrl: res.instance_url };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new OAuthError(`Salesforce refused the connection (${detail}).`);
      }
    },
    isConnected: (secrets) => Boolean(secrets.refreshToken),
  },
};
