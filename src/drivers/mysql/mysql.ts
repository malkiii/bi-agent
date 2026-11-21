/**
 * MySQL and MariaDB driver. Read-only enforcement, in layers:
 * 1. assertReadOnlySql(query, 'mysql'): one SELECT/WITH statement, no write/lock/file keywords,
 *    no executable comments. The pool also keeps `multipleStatements: false`.
 * 2. The query runs inside `START TRANSACTION READ ONLY`, which is always rolled back.
 * 3. Timeouts: the session's max_execution_time (MySQL) or max_statement_time (MariaDB), plus a
 *    client timer that runs `KILL QUERY` on a separate connection. Rows are streamed and only
 *    maxRows + 1 are kept; once the cap is hit the query is killed and the connection dropped.
 */
import mysql from 'mysql2/promise';
import type { FieldPacket, PoolConnection, TypeCastField, TypeCastNext } from 'mysql2/promise';
import type { Connection as CoreConnection } from 'mysql2';
import { z } from 'zod';
import {
  DEFAULT_QUERY_LIMITS,
  QueryFailedError,
  QueryRejectedError,
  QueryTimeoutError,
  type ColumnType,
  type DataSourceDriver,
  type Dialect,
  type DriverKind,
  type IntrospectedDataset,
  type ResultColumn,
} from '@/core/data-sources/driver';
import { exactNumber } from '../sql/exact-number';
import { assertReadOnlySql } from '../sql/read-only-guard';

export interface MysqlConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslMode: 'disable' | 'require' | 'verify-full';
}

export const MYSQL_DIALECT: Dialect = {
  language: 'sql',
  flavour: 'mysql',
  guidance:
    'MySQL / MariaDB. Write one SELECT or WITH statement (no semicolon-separated statements). Quote identifiers ' +
    'with backticks (e.g. `Big Deals`), strings with single quotes. Use LIMIT (not TOP), DATE_FORMAT() or ' +
    "DATE() for periods, CONCAT() for strings. Tables are in the connection's database.",
};

/** MySQL protocol column type codes (mysql2 `FieldPacket.columnType`). */
const MYSQL_TYPE = {
  DECIMAL: 0, TINY: 1, SHORT: 2, LONG: 3, FLOAT: 4, DOUBLE: 5, TIMESTAMP: 7, LONGLONG: 8, INT24: 9,
  DATE: 10, TIME: 11, DATETIME: 12, YEAR: 13, NEWDATE: 14, VARCHAR: 15, BIT: 16, JSON: 245,
  NEWDECIMAL: 246, ENUM: 247, SET: 248, TINY_BLOB: 249, MEDIUM_BLOB: 250, LONG_BLOB: 251, BLOB: 252,
  VAR_STRING: 253, STRING: 254,
} as const;

const BINARY_CHARSET = 63;

function resultColumnType(field: FieldPacket): ColumnType {
  switch (field.columnType) {
    case MYSQL_TYPE.TINY:
    case MYSQL_TYPE.SHORT:
    case MYSQL_TYPE.LONG:
    case MYSQL_TYPE.LONGLONG:
    case MYSQL_TYPE.INT24:
    case MYSQL_TYPE.YEAR:
      return 'integer';
    case MYSQL_TYPE.DECIMAL:
    case MYSQL_TYPE.NEWDECIMAL:
    case MYSQL_TYPE.FLOAT:
    case MYSQL_TYPE.DOUBLE:
      return 'number';
    case MYSQL_TYPE.DATE:
    case MYSQL_TYPE.NEWDATE:
      return 'date';
    case MYSQL_TYPE.DATETIME:
    case MYSQL_TYPE.TIMESTAMP:
      return 'datetime';
    case MYSQL_TYPE.JSON:
      return 'json';
    case MYSQL_TYPE.VARCHAR:
    case MYSQL_TYPE.VAR_STRING:
    case MYSQL_TYPE.STRING:
    case MYSQL_TYPE.ENUM:
    case MYSQL_TYPE.SET:
    case MYSQL_TYPE.TINY_BLOB:
    case MYSQL_TYPE.MEDIUM_BLOB:
    case MYSQL_TYPE.LONG_BLOB:
    case MYSQL_TYPE.BLOB:
      return field.characterSet === BINARY_CHARSET ? 'other' : 'string';
    default:
      return 'other';
  }
}

/** information_schema DATA_TYPE to a normalised type. */
function declaredColumnType(dataType: string): ColumnType {
  switch (dataType.toLowerCase()) {
    case 'tinyint':
    case 'smallint':
    case 'mediumint':
    case 'int':
    case 'integer':
    case 'bigint':
    case 'year':
      return 'integer';
    case 'decimal':
    case 'numeric':
    case 'float':
    case 'double':
    case 'real':
      return 'number';
    case 'char':
    case 'varchar':
    case 'tinytext':
    case 'text':
    case 'mediumtext':
    case 'longtext':
    case 'enum':
    case 'set':
      return 'string';
    case 'date':
      return 'date';
    case 'datetime':
    case 'timestamp':
      return 'datetime';
    case 'json':
      return 'json';
    default:
      return 'other';
  }
}

/** DECIMAL and BIGINT as exact JS numbers where possible, otherwise the engine's text. */
function typeCast(field: TypeCastField, next: TypeCastNext): unknown {
  if (field.type === 'NEWDECIMAL' || field.type === 'DECIMAL' || field.type === 'LONGLONG') {
    const text = field.string();
    return text === null ? null : exactNumber(text);
  }
  return next();
}

const INTROSPECT_SQL = `
  SELECT c.TABLE_SCHEMA AS table_schema, c.TABLE_NAME AS table_name, t.TABLE_TYPE AS table_type,
         c.COLUMN_NAME AS column_name, c.COLUMN_TYPE AS column_type, c.DATA_TYPE AS data_type,
         c.IS_NULLABLE AS is_nullable
  FROM information_schema.COLUMNS c
  JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
  WHERE c.TABLE_SCHEMA = DATABASE()
  ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`;

function quoteIdent(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name : `\`${name.replaceAll('`', '``')}\``;
}

interface MysqlError extends Error {
  code?: string;
  errno?: number;
  sqlState?: string;
  sqlMessage?: string;
}

const ER_QUERY_INTERRUPTED = 1317;
const ER_QUERY_TIMEOUT = 3024; // MySQL max_execution_time
const ER_STATEMENT_TIMEOUT = 1969; // MariaDB max_statement_time

function readableConnectionError(error: unknown, c: MysqlConnection): string {
  const e = error as MysqlError;
  switch (e.code) {
    case 'ECONNREFUSED':
      return `Could not connect to ${c.host}:${c.port}: the connection was refused. Check the host and port.`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Could not find the host "${c.host}".`;
    case 'ETIMEDOUT':
      return `Timed out connecting to ${c.host}:${c.port}.`;
    case 'ER_ACCESS_DENIED_ERROR':
      return `The server refused the login for user "${c.user}": ${e.sqlMessage ?? e.message}.`;
    case 'ER_BAD_DB_ERROR':
    case 'ER_DBACCESS_DENIED_ERROR':
      return `The database "${c.database}" does not exist or this user cannot use it: ${e.sqlMessage ?? e.message}`;
    default:
      return e.sqlMessage || e.message || String(error);
  }
}

function sslOption(mode: MysqlConnection['sslMode']): mysql.PoolOptions['ssl'] {
  if (mode === 'disable') return undefined;
  return { rejectUnauthorized: mode === 'verify-full' };
}

interface Streamed {
  fields: FieldPacket[];
  rows: unknown[][];
  truncated: boolean;
}

export function createMysqlDriver(connection: MysqlConnection): DataSourceDriver {
  const options: mysql.PoolOptions = {
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: connection.password,
    ssl: sslOption(connection.sslMode),
    multipleStatements: false,
    dateStrings: true, // dates without a zone stay as the engine's text
    typeCast,
    connectTimeout: 10_000,
    connectionLimit: 3,
    maxIdle: 3,
    idleTimeout: 30_000,
  };
  const pool = mysql.createPool(options);
  // Idle connections can error when the server goes away; the next checkout reconnects.
  pool.on('connection', (conn) => conn.on('error', () => {}));

  let mariadb: Promise<boolean> | undefined;
  const isMariadb = (conn: PoolConnection) =>
    (mariadb ??= conn
      .query<mysql.RowDataPacket[]>('SELECT VERSION() AS v')
      .then(([rows]) => /mariadb/i.test(String(rows[0]?.v)))
      .catch((error) => {
        mariadb = undefined;
        throw error;
      }));

  async function connect(): Promise<PoolConnection> {
    try {
      return await pool.getConnection();
    } catch (error) {
      throw new QueryFailedError(readableConnectionError(error, connection));
    }
  }

  /** `KILL QUERY` from a separate connection, so a full pool cannot block it. */
  async function killQuery(threadId: number): Promise<void> {
    const { host, port, user, password, ssl, connectTimeout } = options;
    const killer = await mysql.createConnection({ host, port, user, password, ssl, connectTimeout });
    try {
      await killer.query(`KILL QUERY ${Math.floor(threadId)}`);
    } finally {
      await killer.end().catch(() => {});
    }
  }

  /**
   * Runs `sql` in a rolled-back read-only transaction, streaming rows and keeping maxRows + 1.
   * A connection whose query was killed (cap or timeout) is destroyed rather than reused.
   */
  async function readOnly(sql: string, timeoutMs: number, maxRows: number): Promise<Streamed> {
    const conn = await connect();
    let discard = false;
    try {
      // The server limit is a backstop a second after the client timer: a server-interrupted
      // SLEEP() returns normally, so the client timer must be the one that decides.
      const serverMs = Math.max(1, Math.floor(timeoutMs)) + 1000;
      await conn.query(
        (await isMariadb(conn))
          ? `SET SESSION max_statement_time = ${serverMs / 1000}`
          : `SET SESSION max_execution_time = ${serverMs}`,
      );
      await conn.query('START TRANSACTION READ ONLY');

      const threadId = conn.threadId;
      let timedOut = false;
      let capped = false;
      const result: Streamed = { fields: [], rows: [], truncated: false };
      const kill = () => {
        discard = true;
        killQuery(threadId).catch(() => {});
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);

      try {
        await new Promise<void>((resolve, reject) => {
          // mysql2 types `.connection` as the promise wrapper; at runtime it is the core (streaming) connection.
          (conn.connection as unknown as CoreConnection)
            .query({ sql, rowsAsArray: true })
            .on('fields', (fields: FieldPacket[]) => {
              if (result.fields.length === 0) result.fields = fields;
            })
            .on('result', (row: unknown) => {
              if (capped) return;
              result.rows.push(row as unknown[]);
              if (result.rows.length > maxRows) {
                capped = true;
                result.truncated = true;
                result.rows.length = maxRows;
                kill();
              }
            })
            .on('error', (error: MysqlError) => reject(error))
            .on('end', () => resolve());
        });
      } catch (error) {
        const e = error as MysqlError;
        if (timedOut || e.errno === ER_QUERY_TIMEOUT || e.errno === ER_STATEMENT_TIMEOUT) {
          throw new QueryTimeoutError(timeoutMs);
        }
        if (!(capped && e.errno === ER_QUERY_INTERRUPTED)) throw error;
      } finally {
        clearTimeout(timer);
      }
      // SLEEP() interrupted by KILL QUERY returns 1 instead of failing.
      if (timedOut && !capped) throw new QueryTimeoutError(timeoutMs);
      return result;
    } catch (error) {
      if (error instanceof QueryTimeoutError) throw error;
      const e = error as MysqlError;
      if (e.sqlState) throw new QueryFailedError(e.sqlMessage ?? e.message);
      discard = true;
      throw new QueryFailedError(readableConnectionError(e, connection));
    } finally {
      if (discard) {
        conn.destroy();
      } else {
        await conn.query('ROLLBACK').then(
          () => conn.release(),
          () => conn.destroy(),
        );
      }
    }
  }

  function columns(fields: FieldPacket[]): ResultColumn[] {
    return fields.map((f) => ({ name: f.name, type: resultColumnType(f) }));
  }

  return {
    dialect: MYSQL_DIALECT,

    async testConnection() {
      try {
        const conn = await pool.getConnection();
        try {
          await conn.query('SELECT 1');
        } finally {
          conn.release();
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error: readableConnectionError(error, connection) };
      }
    },

    async introspect() {
      const { rows } = await readOnly(INTROSPECT_SQL, DEFAULT_QUERY_LIMITS.timeoutMs, Number.MAX_SAFE_INTEGER);
      const datasets = new Map<string, IntrospectedDataset>();
      for (const [schema, name, tableType, column, columnType, dataType, isNullable] of rows as string[][]) {
        const id = quoteIdent(name!);
        let dataset = datasets.get(id);
        if (!dataset) {
          dataset = { id, name: name!, schema: schema!, kind: /view/i.test(tableType!) ? 'view' : 'table', columns: [] };
          datasets.set(id, dataset);
        }
        dataset.columns.push({
          name: column!,
          type: declaredColumnType(dataType!),
          nativeType: columnType!,
          nullable: isNullable === 'YES',
        });
      }
      return [...datasets.values()];
    },

    async execute(query, limits) {
      if (typeof query !== 'string') throw new QueryRejectedError('MySQL Data Sources take a SQL string.');
      const sql = assertReadOnlySql(query, 'mysql');
      const { timeoutMs, maxRows } = { ...DEFAULT_QUERY_LIMITS, ...limits };
      const started = performance.now();
      const result = await readOnly(sql, timeoutMs, Math.floor(maxRows));
      return {
        columns: columns(result.fields),
        rows: result.rows,
        truncated: result.truncated,
        durationMs: Math.round(performance.now() - started),
      };
    },

    async close() {
      await pool.end();
    },
  };
}

const mysqlConfigSchema = z.object({
  host: z.string().trim().min(1, 'Host is required'),
  port: z.coerce.number().int().min(1).max(65535).default(3306),
  database: z.string().trim().min(1, 'Database is required'),
  user: z.string().trim().min(1, 'User is required'),
  sslMode: z.enum(['disable', 'require', 'verify-full']).default('require'),
});

export const mysqlKind: DriverKind<z.infer<typeof mysqlConfigSchema>, { password: string }> = {
  kind: 'mysql',
  label: 'MySQL / MariaDB',
  fields: [
    { key: 'host', label: 'Host', input: 'text', required: true },
    { key: 'port', label: 'Port', input: 'number', required: true, defaultValue: '3306' },
    { key: 'database', label: 'Database', input: 'text', required: true },
    {
      key: 'user',
      label: 'User',
      input: 'text',
      required: true,
      help: 'Use a read-only user with only SELECT on the tables BIBot should see.',
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
  configSchema: mysqlConfigSchema,
  secretsSchema: z.object({ password: z.string({ error: 'Password is required' }).min(1, 'Password is required') }),
  create: (config, secrets) => createMysqlDriver({ ...config, password: secrets.password }),
};
