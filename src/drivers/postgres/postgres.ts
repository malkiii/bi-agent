/**
 * PostgreSQL driver. Read-only enforcement, in layers:
 * 1. assertReadOnlySql: one SELECT/WITH statement, no write/DDL keywords.
 * 2. The query runs through the extended protocol (one statement per message) as a cursor
 *    inside `BEGIN TRANSACTION READ ONLY`, which is always rolled back.
 * 3. `SET LOCAL statement_timeout` cancels slow queries; only maxRows + 1 rows are fetched.
 */
import pg from 'pg';
import { z } from 'zod';
import {
  DEFAULT_QUERY_LIMITS,
  QueryFailedError,
  QueryRejectedError,
  QueryTimeoutError,
  type Column,
  type ColumnType,
  type DataSourceDriver,
  type DatasetKind,
  type Dialect,
  type DriverKind,
  type IntrospectedDataset,
} from '@/core/data-sources/driver';
import { exactNumber } from '../sql/exact-number';
import { assertReadOnlySql } from '../sql/read-only-guard';

export interface PostgresConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslMode: 'disable' | 'require' | 'verify-full';
}

export const POSTGRES_DIALECT: Dialect = {
  language: 'sql',
  flavour: 'postgresql',
  guidance:
    'PostgreSQL. Write one SELECT or WITH statement. Quote mixed-case or spaced identifiers with double quotes ' +
    '(e.g. sales."Big Deals"), use single quotes for strings, date_trunc() for periods, and ::numeric casts for division.',
};

const OID = {
  bool: 16,
  int8: 20,
  int2: 21,
  int4: 23,
  text: 25,
  oid: 26,
  json: 114,
  float4: 700,
  float8: 701,
  bpchar: 1042,
  varchar: 1043,
  date: 1082,
  timestamp: 1114,
  timestamptz: 1184,
  numeric: 1700,
  uuid: 2950,
  jsonb: 3802,
  name: 19,
  char: 18,
} as const;

function columnType(oid: number): ColumnType {
  switch (oid) {
    case OID.bool:
      return 'boolean';
    case OID.int2:
    case OID.int4:
    case OID.int8:
    case OID.oid:
      return 'integer';
    case OID.float4:
    case OID.float8:
    case OID.numeric:
      return 'number';
    case OID.text:
    case OID.varchar:
    case OID.bpchar:
    case OID.name:
    case OID.char:
    case OID.uuid:
      return 'string';
    case OID.date:
      return 'date';
    case OID.timestamp:
    case OID.timestamptz:
      return 'datetime';
    case OID.json:
    case OID.jsonb:
      return 'json';
    default:
      return 'other';
  }
}

const typeParsers: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: string) => {
    if (format === 'binary') return pg.types.getTypeParser(oid, 'binary');
    switch (oid) {
      case OID.int8:
      case OID.numeric:
        return exactNumber;
      case OID.date:
      case OID.timestamp:
        return (text: string) => text; // no zone: keep the engine's text rather than guess one
      default:
        return pg.types.getTypeParser(oid, 'text');
    }
  }) as pg.CustomTypesConfig['getTypeParser'],
};

const RELKIND: Record<string, DatasetKind> = { r: 'table', p: 'table', f: 'table', v: 'view', m: 'view' };

const INTROSPECT_SQL = `
  SELECT n.nspname AS schema, c.relname AS name, c.relkind AS relkind, a.attname AS column,
         format_type(a.atttypid, a.atttypmod) AS native_type, a.atttypid::int AS type_oid,
         NOT a.attnotnull AS nullable
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE c.relkind IN ('r', 'p', 'f', 'v', 'm')
    AND NOT c.relispartition
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
    AND has_table_privilege(c.oid, 'SELECT')
  ORDER BY n.nspname, c.relname, a.attnum`;

function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

function sslOption(mode: PostgresConnection['sslMode']): pg.ClientConfig['ssl'] {
  if (mode === 'disable') return false;
  return { rejectUnauthorized: mode === 'verify-full' };
}

interface PgError extends Error {
  code?: string;
}

function readableConnectionError(error: unknown, c: PostgresConnection): string {
  const e = error as PgError;
  switch (e.code) {
    case 'ECONNREFUSED':
      return `Could not connect to ${c.host}:${c.port}: the connection was refused. Check the host and port.`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Could not find the host "${c.host}".`;
    case 'ETIMEDOUT':
      return `Timed out connecting to ${c.host}:${c.port}.`;
    case '28P01':
    case '28000':
      return `The server refused the login for user "${c.user}": ${e.message}.`;
    case '3D000':
      return `The database "${c.database}" does not exist.`;
    default:
      if (/timeout/i.test(e.message)) return `Timed out connecting to ${c.host}:${c.port}.`;
      return e.message || String(error);
  }
}

export function createPostgresDriver(connection: PostgresConnection): DataSourceDriver {
  const pool = new pg.Pool({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: connection.password,
    ssl: sslOption(connection.sslMode),
    max: 3,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    application_name: 'bibot',
    types: typeParsers,
  });
  // Idle clients can error when the server goes away; the next checkout reconnects.
  pool.on('error', () => {});

  async function connect(): Promise<pg.PoolClient> {
    try {
      return await pool.connect();
    } catch (error) {
      throw new QueryFailedError(readableConnectionError(error, connection));
    }
  }

  /** Runs `work` inside a read-only transaction that is always rolled back. */
  async function readOnly<T>(timeoutMs: number, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
      return await work(client);
    } catch (error) {
      const e = error as PgError;
      if (e.code === '57014') throw new QueryTimeoutError(timeoutMs);
      if (e.code && /^[0-9A-Z]{5}$/.test(e.code)) throw new QueryFailedError(e.message);
      broken = e;
      throw new QueryFailedError(readableConnectionError(e, connection));
    } finally {
      if (!broken) await client.query('ROLLBACK').catch((e: Error) => (broken = e));
      client.release(broken);
    }
  }

  return {
    dialect: POSTGRES_DIALECT,

    async testConnection() {
      try {
        const client = await pool.connect();
        try {
          await client.query('SELECT 1');
        } finally {
          client.release();
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error: readableConnectionError(error, connection) };
      }
    },

    async introspect() {
      const { rows } = await readOnly(DEFAULT_QUERY_LIMITS.timeoutMs, (client) => client.query(INTROSPECT_SQL));
      const datasets = new Map<string, IntrospectedDataset>();
      for (const row of rows as {
        schema: string;
        name: string;
        relkind: string;
        column: string;
        native_type: string;
        type_oid: number;
        nullable: boolean;
      }[]) {
        const id = `${quoteIdent(row.schema)}.${quoteIdent(row.name)}`;
        let dataset = datasets.get(id);
        if (!dataset) {
          dataset = { id, name: row.name, schema: row.schema, kind: RELKIND[row.relkind] ?? 'table', columns: [] };
          datasets.set(id, dataset);
        }
        const column: Column = {
          name: row.column,
          type: columnType(row.type_oid),
          nativeType: row.native_type,
          nullable: row.nullable,
        };
        dataset.columns.push(column);
      }
      return [...datasets.values()];
    },

    async execute(query, limits) {
      if (typeof query !== 'string') throw new QueryRejectedError('Postgres Data Sources take a SQL string.');
      const sql = assertReadOnlySql(query, 'postgresql');
      const { timeoutMs, maxRows } = { ...DEFAULT_QUERY_LIMITS, ...limits };
      const started = performance.now();

      const result = await readOnly(timeoutMs, async (client) => {
        // `values` forces the extended protocol, which refuses more than one statement.
        await client.query({ text: `DECLARE bibot_result NO SCROLL CURSOR FOR ${sql}\n`, values: [] });
        return client.query<unknown[]>({
          text: `FETCH FORWARD ${Math.floor(maxRows) + 1} FROM bibot_result`,
          rowMode: 'array',
        });
      });

      const truncated = result.rows.length > maxRows;
      return {
        columns: result.fields.map((f) => ({ name: f.name, type: columnType(f.dataTypeID) })),
        rows: truncated ? result.rows.slice(0, maxRows) : result.rows,
        truncated,
        durationMs: Math.round(performance.now() - started),
      };
    },

    async close() {
      await pool.end();
    },
  };
}

const postgresConfigSchema = z.object({
  host: z.string().trim().min(1, 'Host is required'),
  port: z.coerce.number().int().min(1).max(65535).default(5432),
  database: z.string().trim().min(1, 'Database is required'),
  user: z.string().trim().min(1, 'User is required'),
  sslMode: z.enum(['disable', 'require', 'verify-full']).default('require'),
});

export const postgresKind: DriverKind<z.infer<typeof postgresConfigSchema>, { password: string }> = {
  kind: 'postgres',
  label: 'PostgreSQL',
  fields: [
    { key: 'host', label: 'Host', input: 'text', required: true },
    { key: 'port', label: 'Port', input: 'number', required: true, defaultValue: '5432' },
    { key: 'database', label: 'Database', input: 'text', required: true },
    {
      key: 'user',
      label: 'User',
      input: 'text',
      required: true,
      help: 'Use a read-only database user that can only SELECT the tables BIBot should see.',
    },
    { key: 'password', label: 'Password', input: 'password', secret: true, required: true },
    {
      key: 'sslMode',
      label: 'SSL',
      input: 'select',
      defaultValue: 'require',
      options: [
        { value: 'require', label: 'Require (encrypt, do not verify certificate)' },
        { value: 'verify-full', label: 'Verify full (encrypt and verify certificate)' },
        { value: 'disable', label: 'Disable' },
      ],
    },
  ],
  configSchema: postgresConfigSchema,
  secretsSchema: z.object({ password: z.string({ error: 'Password is required' }).min(1, 'Password is required') }),
  create: (config, secrets) => createPostgresDriver({ ...config, password: secrets.password }),
};
