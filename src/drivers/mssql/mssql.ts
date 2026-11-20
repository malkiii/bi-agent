/**
 * SQL Server driver. SQL Server has no read-only transaction, so enforcement is:
 * 1. assertReadOnlySql(query, 'tsql'): one SELECT/WITH statement and no write, EXEC, SELECT INTO,
 *    OPENROWSET/OPENQUERY, WAITFOR, NEXT VALUE FOR or transaction keyword. T-SQL needs no semicolon between
 *    statements, so the guard refuses every statement keyword, not just `;`.
 * 2. The query runs inside a transaction that is always rolled back.
 * 3. A client timer cancels the request at the timeout; rows are streamed and the request is
 *    cancelled once maxRows + 1 have arrived. Only the first result set is returned.
 * Admins should still connect with a login that only has db_datareader.
 */
import sql from 'mssql';
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

export interface MssqlConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** `disable` = no encryption, `require` = encrypt without verifying, `verify-full` = encrypt and verify. */
  sslMode: 'disable' | 'require' | 'verify-full';
}

export const MSSQL_DIALECT: Dialect = {
  language: 'sql',
  flavour: 'tsql',
  guidance:
    'Microsoft SQL Server (T-SQL). Write one SELECT or WITH statement. Use TOP n or OFFSET ... FETCH (there is ' +
    'no LIMIT). Quote identifiers with square brackets (e.g. dbo.[Big Deals]), strings with single quotes. Use ' +
    "DATEFROMPARTS(YEAR(d), MONTH(d), 1) or FORMAT(d, 'yyyy-MM') for periods (DATETRUNC needs SQL Server 2022), " +
    'CAST(x AS decimal(18,2)) for division, and + or CONCAT() for strings.',
};

/** INFORMATION_SCHEMA / result column type name to a normalised type. */
function columnType(typeName: string): ColumnType {
  switch (typeName.toLowerCase()) {
    case 'tinyint':
    case 'smallint':
    case 'int':
    case 'bigint':
      return 'integer';
    case 'decimal':
    case 'numeric':
    case 'money':
    case 'smallmoney':
    case 'float':
    case 'real':
      return 'number';
    case 'bit':
      return 'boolean';
    case 'char':
    case 'varchar':
    case 'nchar':
    case 'nvarchar':
    case 'text':
    case 'ntext':
    case 'uniqueidentifier':
      return 'string';
    case 'date':
      return 'date';
    case 'datetime':
    case 'datetime2':
    case 'smalldatetime':
    case 'datetimeoffset':
      return 'datetime';
    default:
      return 'other';
  }
}

/** Zone-less date types; tedious returns them as Dates read as UTC, which we turn back into text. */
const ZONELESS = new Set(['date', 'datetime', 'datetime2', 'smalldatetime']);

function zonelessText(value: Date, typeName: string): string {
  const iso = value.toISOString(); // e.g. 2026-01-05T10:00:00.000Z, exactly the stored value under useUTC
  if (typeName === 'date') return iso.slice(0, 10);
  return iso.slice(0, 23).replace('T', ' ').replace(/\.000$/, '');
}

/** The SQL type name of a result column, e.g. `int`, `nvarchar`. */
function resultTypeName(column: sql.IColumnMetadata[string]): string {
  const type = column.type as unknown as { declaration?: string; name?: string };
  return (type.declaration ?? type.name ?? '').toLowerCase();
}

function convert(value: unknown, typeName: string): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date && ZONELESS.has(typeName)) return zonelessText(value, typeName);
  if (typeName === 'bigint' && typeof value === 'string') return exactNumber(value);
  return value;
}

const INTROSPECT_SQL = `
  SELECT c.TABLE_SCHEMA, c.TABLE_NAME, t.TABLE_TYPE, c.COLUMN_NAME, c.DATA_TYPE,
         c.CHARACTER_MAXIMUM_LENGTH, c.NUMERIC_PRECISION, c.NUMERIC_SCALE, c.IS_NULLABLE
  FROM INFORMATION_SCHEMA.COLUMNS c
  JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
  ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`;

function nativeType(dataType: string, length: number | null, precision: number | null, scale: number | null): string {
  if (['decimal', 'numeric'].includes(dataType)) return `${dataType}(${precision},${scale})`;
  if (['char', 'varchar', 'nchar', 'nvarchar', 'binary', 'varbinary'].includes(dataType) && length !== null) {
    return `${dataType}(${length === -1 ? 'max' : length})`;
  }
  return dataType;
}

function quoteIdent(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `[${name.replaceAll(']', ']]')}]`;
}

interface MssqlError extends Error {
  code?: string;
  number?: number;
  originalError?: Error & { code?: string };
}

function readableConnectionError(error: unknown, c: MssqlConnection): string {
  const e = error as MssqlError;
  const cause = e.originalError?.message ?? '';
  if (e.code === 'ELOGIN') {
    // SQL Server gives the same message for a wrong password and a database the login cannot open.
    return (
      `The server refused the login for user "${c.user}" to database "${c.database}". ` +
      `Check the user, password and database name. (${e.message})`
    );
  }
  if (e.code === 'ESOCKET' || /ECONNREFUSED/.test(cause + e.message)) {
    if (/ENOTFOUND|EAI_AGAIN/.test(cause + e.message)) return `Could not find the host "${c.host}".`;
    return `Could not connect to ${c.host}:${c.port}: the connection was refused. Check the host and port.`;
  }
  if (e.code === 'ETIMEOUT') return `Timed out connecting to ${c.host}:${c.port}.`;
  return e.message || String(error);
}

interface Streamed {
  columns: ResultColumn[];
  rows: unknown[][];
  truncated: boolean;
}

export function createMssqlDriver(connection: MssqlConnection): DataSourceDriver {
  const pool = new sql.ConnectionPool({
    server: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: connection.password,
    connectionTimeout: 10_000,
    // Off: SQL Server has no per-statement server timeout, so the client timer in readOnly()
    // cancels the request (a TDS attention, which stops it on the server) at the query's timeout.
    requestTimeout: 0,
    pool: { max: 3, min: 0, idleTimeoutMillis: 30_000 },
    options: {
      encrypt: connection.sslMode !== 'disable',
      trustServerCertificate: connection.sslMode !== 'verify-full',
      appName: 'botley',
      useUTC: true,
    },
  });
  // Idle connections can error when the server goes away; the next request reconnects.
  pool.on('error', () => {});

  let connecting: Promise<sql.ConnectionPool> | undefined;
  function connect(): Promise<sql.ConnectionPool> {
    connecting ??= pool.connect().catch((error) => {
      connecting = undefined;
      throw error;
    });
    return connecting;
  }

  /** Runs `query` in a transaction that is always rolled back, streaming at most maxRows + 1 rows. */
  async function readOnly(query: string, timeoutMs: number, maxRows: number): Promise<Streamed> {
    try {
      await connect();
    } catch (error) {
      throw new QueryFailedError(readableConnectionError(error, connection));
    }

    const tx = new sql.Transaction(pool);
    try {
      await tx.begin();
    } catch (error) {
      throw new QueryFailedError(readableConnectionError(error, connection));
    }

    const result: Streamed = { columns: [], rows: [], truncated: false };
    let typeNames: string[] = [];
    let recordsets = 0;
    let timedOut = false;
    let capped = false;

    const request = new sql.Request(tx);
    request.stream = true;
    request.arrayRowMode = true;
    const timer = setTimeout(() => {
      timedOut = true;
      request.cancel();
    }, timeoutMs);

    try {
      // Wait for 'done' (always emitted in stream mode, after any 'error') so the request has
      // finished before the rollback; rolling back mid-request would leak the connection.
      let failure: unknown;
      await new Promise<void>((resolve) => {
        request.on('recordset', (columns: sql.IColumnMetadata | sql.IColumnMetadata[string][]) => {
          recordsets++;
          if (recordsets > 1) return;
          const list = Array.isArray(columns) ? columns : Object.values(columns).sort((a, b) => a.index - b.index);
          typeNames = list.map(resultTypeName);
          result.columns = list.map((c, i) => ({ name: c.name, type: columnType(typeNames[i]!) }));
        });
        request.on('row', (row: unknown[]) => {
          if (recordsets > 1 || capped) return;
          if (result.rows.length === maxRows) {
            capped = true;
            result.truncated = true;
            request.cancel();
            return;
          }
          result.rows.push(row.map((value, i) => convert(value, typeNames[i] ?? '')));
        });
        request.on('error', (error: unknown) => (failure ??= error));
        request.on('done', () => resolve());
        request.query(query);
      });
      if (failure) throw failure;
      if (timedOut && !capped) throw new QueryTimeoutError(timeoutMs);
      return result;
    } catch (error) {
      if (error instanceof QueryTimeoutError) throw error;
      const e = error as MssqlError;
      if (timedOut || e.code === 'ETIMEOUT') throw new QueryTimeoutError(timeoutMs);
      if (capped && e.code === 'ECANCEL') return result;
      if (typeof e.number === 'number' || e.code === 'EREQUEST') throw new QueryFailedError(e.message);
      throw new QueryFailedError(readableConnectionError(e, connection));
    } finally {
      clearTimeout(timer);
      await tx.rollback().catch(() => {});
    }
  }

  return {
    dialect: MSSQL_DIALECT,

    async testConnection() {
      try {
        await connect();
        await pool.request().query('SELECT 1');
        return { ok: true };
      } catch (error) {
        return { ok: false, error: readableConnectionError(error, connection) };
      }
    },

    async introspect() {
      const { rows } = await readOnly(INTROSPECT_SQL, DEFAULT_QUERY_LIMITS.timeoutMs, Number.MAX_SAFE_INTEGER);
      const datasets = new Map<string, IntrospectedDataset>();
      for (const row of rows) {
        const [schema, name, tableType, column, dataType, length, precision, scale, isNullable] = row as [
          string, string, string, string, string, number | null, number | null, number | null, string,
        ];
        const id = `${quoteIdent(schema)}.${quoteIdent(name)}`;
        let dataset = datasets.get(id);
        if (!dataset) {
          dataset = { id, name, schema, kind: tableType === 'VIEW' ? 'view' : 'table', columns: [] };
          datasets.set(id, dataset);
        }
        dataset.columns.push({
          name: column,
          type: columnType(dataType),
          nativeType: nativeType(dataType, length, precision, scale),
          nullable: isNullable === 'YES',
        });
      }
      return [...datasets.values()];
    },

    async execute(query, limits) {
      if (typeof query !== 'string') throw new QueryRejectedError('SQL Server Data Sources take a SQL string.');
      const text = assertReadOnlySql(query, 'tsql');
      const { timeoutMs, maxRows } = { ...DEFAULT_QUERY_LIMITS, ...limits };
      const started = performance.now();
      const result = await readOnly(text, timeoutMs, Math.floor(maxRows));
      return { ...result, durationMs: Math.round(performance.now() - started) };
    },

    async close() {
      await pool.close().catch(() => {});
    },
  };
}

const mssqlConfigSchema = z.object({
  host: z.string().trim().min(1, 'Host is required'),
  port: z.coerce.number().int().min(1).max(65535).default(1433),
  database: z.string().trim().min(1, 'Database is required'),
  user: z.string().trim().min(1, 'User is required'),
  sslMode: z.enum(['disable', 'require', 'verify-full']).default('require'),
});

export const mssqlKind: DriverKind<z.infer<typeof mssqlConfigSchema>, { password: string }> = {
  kind: 'mssql',
  label: 'SQL Server',
  fields: [
    { key: 'host', label: 'Host', input: 'text', required: true },
    { key: 'port', label: 'Port', input: 'number', required: true, defaultValue: '1433' },
    { key: 'database', label: 'Database', input: 'text', required: true },
    {
      key: 'user',
      label: 'User',
      input: 'text',
      required: true,
      help: 'SQL Server has no read-only transactions: use a login whose only role is db_datareader.',
    },
    { key: 'password', label: 'Password', input: 'password', secret: true, required: true },
    {
      key: 'sslMode',
      label: 'Encryption',
      input: 'select',
      defaultValue: 'require',
      options: [
        { value: 'require', label: 'Encrypt, trust the server certificate' },
        { value: 'verify-full', label: 'Encrypt and verify the certificate' },
        { value: 'disable', label: 'Do not encrypt' },
      ],
    },
  ],
  configSchema: mssqlConfigSchema,
  secretsSchema: z.object({ password: z.string({ error: 'Password is required' }).min(1, 'Password is required') }),
  create: (config, secrets) => createMssqlDriver({ ...config, password: secrets.password }),
};
