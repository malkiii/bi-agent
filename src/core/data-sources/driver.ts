/**
 * The Data Source driver contract. Every Data Source kind (Postgres, MySQL, SQL Server,
 * MongoDB, Salesforce, Uploads) implements `DataSourceDriver` and is registered as a
 * `DriverKind`. Implementations live in `src/drivers`; every one must pass the shared
 * contract suite in `src/drivers/contract`.
 *
 * Read-only enforcement lives inside the drivers, so every caller is protected.
 */
import type { z } from 'zod';
import { AppError } from '../errors';

/** Tells the model which query language and flavour to write for a Data Source. */
export interface Dialect {
  language: 'sql' | 'mongo' | 'soql';
  /** e.g. 'postgresql', 'mysql', 'tsql', 'duckdb'. */
  flavour: string;
  /** Short prompt guidance: quoting, limits, functions worth knowing. */
  guidance: string;
}

/** Engine-independent column type, so the agent and UI can reason across kinds. */
export type ColumnType = 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'datetime' | 'json' | 'other';

export interface Column {
  name: string;
  type: ColumnType;
  /** The engine's own type name, e.g. `numeric(10,2)`, `timestamptz`. */
  nativeType: string;
  nullable: boolean;
}

export type DatasetKind = 'table' | 'view' | 'collection' | 'object' | 'sheet';

/** One queryable table/view/collection/object/sheet found by introspection. */
export interface IntrospectedDataset {
  /** Stable identifier, unique within the Data Source; how the query refers to it (e.g. `public.orders`). */
  id: string;
  name: string;
  /** Schema/namespace, or null where the kind has none. */
  schema: string | null;
  kind: DatasetKind;
  columns: Column[];
}

/** SQL/SOQL kinds take a string; MongoDB takes a structured find/aggregate request. */
export type DriverQuery = string | Readonly<Record<string, unknown>>;

export interface QueryLimits {
  /** Statement timeout. */
  timeoutMs: number;
  /** Rows beyond this are dropped and `truncated` is set. */
  maxRows: number;
}

export const DEFAULT_QUERY_LIMITS: QueryLimits = { timeoutMs: 30_000, maxRows: 10_000 };

export interface ResultColumn {
  name: string;
  type: ColumnType;
}

export interface QueryResult {
  columns: ResultColumn[];
  /** One array per row, values in `columns` order. Numbers are JS numbers when they fit exactly. */
  rows: unknown[][];
  /** True when the query produced more than `maxRows` rows. */
  truncated: boolean;
  durationMs: number;
}

export type ConnectionTestResult = { ok: true } | { ok: false; error: string };

export interface DataSourceDriver {
  readonly dialect: Dialect;
  /** Never throws: reports a readable error instead. */
  testConnection(): Promise<ConnectionTestResult>;
  introspect(): Promise<IntrospectedDataset[]>;
  /**
   * Runs one read-only query. Throws QueryRejectedError (not read-only / malformed),
   * QueryTimeoutError, or QueryFailedError (the engine's message, for the model to fix).
   */
  execute(query: DriverQuery, limits?: Partial<QueryLimits>): Promise<QueryResult>;
  /** Releases connections. The driver is unusable afterwards. */
  close(): Promise<void>;
}

/** Describes one input on the admin Data Source form. */
export interface DriverField {
  key: string;
  label: string;
  input: 'text' | 'number' | 'password' | 'select';
  /** Secret fields are encrypted at rest and never returned to clients. */
  secret?: boolean;
  required?: boolean;
  options?: readonly { value: string; label: string }[];
  defaultValue?: string;
  help?: string;
}

/**
 * A Data Source kind: how its connection settings are described, validated and turned into a driver.
 * `config` holds the non-secret settings; `secrets` the fields marked `secret`.
 */
export interface DriverKind<TConfig = Record<string, unknown>, TSecrets = Record<string, string>> {
  kind: string;
  label: string;
  /**
   * Created and kept up to date by the App Core rather than the admin form (the built-in Uploads
   * Data Source). Hidden from "Add", and admins cannot edit or delete it; they can still refresh
   * its schema and choose its Exposed Datasets.
   */
  managed?: boolean;
  fields: readonly DriverField[];
  configSchema: z.ZodType<TConfig>;
  secretsSchema: z.ZodType<TSecrets>;
  create(config: TConfig, secrets: TSecrets, context?: DriverContext<TSecrets>): DataSourceDriver;
  /** Present for kinds connected through an OAuth consent screen (Salesforce) rather than typed credentials. */
  oauth?: DriverOAuth<TConfig, TSecrets>;
}

/** What the App Core offers a driver it creates for a saved Data Source. */
export interface DriverContext<TSecrets = Record<string, string>> {
  /**
   * Merges `update` into the Data Source's sealed secrets, e.g. OAuth tokens refreshed by
   * the driver. A no-op for drivers that are not tied to a saved Data Source (an unsaved test).
   */
  saveSecrets(update: Partial<TSecrets>): Promise<void>;
}

/**
 * OAuth authorization-code flow with PKCE for a kind. The App Core owns the state, the
 * verifier and the token storage; the kind only knows its provider's endpoints.
 * Secrets that are not form fields (the tokens) are dropped when the config changes.
 */
export interface DriverOAuth<TConfig, TSecrets> {
  /** e.g. 'Salesforce', for "Connect to Salesforce". */
  providerLabel: string;
  /** The provider's consent screen URL. */
  authorizationUrl(config: TConfig, request: { redirectUri: string; state: string; codeChallenge: string }): string;
  /** Exchanges the code for tokens, returned as secrets to merge. Throws OAuthError with a readable message. */
  exchangeCode(
    config: TConfig,
    secrets: TSecrets,
    request: { code: string; codeVerifier: string; redirectUri: string },
  ): Promise<Partial<TSecrets>>;
  isConnected(secrets: TSecrets): boolean;
}

/** The kinds the App Core can manage, keyed by `DriverKind.kind`. */
export type DriverRegistry = Readonly<Record<string, AnyDriverKind>>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a registry holds kinds of every config shape
export type AnyDriverKind = DriverKind<any, any>;

/** The query is not a single read-only statement (or is malformed for this kind). */
export class QueryRejectedError extends AppError {
  constructor(message: string) {
    super('query_rejected', message);
  }
}

export class QueryTimeoutError extends AppError {
  constructor(timeoutMs: number) {
    super('query_timeout', `The query was cancelled after ${Math.round(timeoutMs / 1000)} s.`);
  }
}

/** The engine refused or failed the query; the message is the engine's, for the model to correct. */
export class QueryFailedError extends AppError {
  constructor(message: string) {
    super('query_failed', message);
  }
}

/** An OAuth connect attempt failed (refused consent, bad client credentials, expired state). */
export class OAuthError extends AppError {
  constructor(
    message: string,
    /** The Data Source being connected, when known, so the UI can return to it. */
    readonly dataSourceId?: string,
  ) {
    super('oauth_failed', message);
  }
}
