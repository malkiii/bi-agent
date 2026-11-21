/**
 * The Uploads driver (ADR 0003): every `<id>.parquet` file in one directory is a Dataset,
 * queried as a view of the same name through a fresh in-memory DuckDB. Read-only
 * enforcement, in layers:
 * 1. assertReadOnlySql(query, 'duckdb'): one SELECT/WITH statement, no write/file/setting keywords.
 * 2. The engine is sandboxed before any query runs: external access is off except for the
 *    Dataset files themselves (read through their views), and the configuration is locked, so a query
 *    can neither read other files nor turn the sandbox off. The database is in memory and thrown
 *    away on close, so nothing a query could create outlives it.
 * 3. A timer interrupts queries past the timeout; rows are streamed and only maxRows + 1 kept.
 */
import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import {
  DEFAULT_QUERY_LIMITS,
  QueryFailedError,
  QueryRejectedError,
  QueryTimeoutError,
  type ColumnType,
  type DataSourceDriver,
  type Dialect,
  type IntrospectedDataset,
  type QueryLimits,
  type QueryResult,
} from '@/core/data-sources/driver';
import { IDENTIFIER_PATTERN } from '@/core/uploads/column-types';
import { assertReadOnlySql } from '../sql/read-only-guard';

export const DUCKDB_DIALECT: Dialect = {
  language: 'sql',
  flavour: 'duckdb',
  guidance:
    'DuckDB SQL over uploaded spreadsheets. Write one SELECT or WITH statement. Each Dataset is a table named by its ' +
    'id; quote other identifiers with double quotes, strings with single quotes. Use LIMIT, date_trunc(\'month\', d), ' +
    "strftime(d, '%Y-%m'), and GROUP BY ALL. Reading files (read_csv, read_parquet, file paths) is not allowed.",
};

const PARQUET = '.parquet';

/** DuckDB accepts forward slashes on every platform; the sandbox compares path prefixes. */
export function duckDbPath(file: string): string {
  return path.resolve(file).replaceAll('\\', '/');
}

export function sqlString(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** DuckDB's type name (e.g. `DECIMAL(10,2)`, `TIMESTAMP WITH TIME ZONE`) to a normalised type. */
export function duckDbColumnType(nativeType: string): ColumnType {
  const t = nativeType.toUpperCase();
  if (/^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT)$/.test(t)) return 'integer';
  if (/^(FLOAT|DOUBLE|DECIMAL)/.test(t)) return 'number';
  if (t === 'VARCHAR' || t === 'UUID') return 'string';
  if (t === 'BOOLEAN') return 'boolean';
  if (t === 'DATE') return 'date';
  if (t.startsWith('TIMESTAMP')) return 'datetime';
  if (t === 'JSON' || t.startsWith('STRUCT') || t.startsWith('MAP') || t.endsWith(']')) return 'json';
  return 'other';
}

/** BIGINTs that fit exactly become numbers, others text; dates become `YYYY-MM-DD`. */
function toJsonFriendly(value: unknown, type: ColumnType): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) return type === 'date' ? value.toISOString().slice(0, 10) : value;
  if (Array.isArray(value)) return value.map((v) => toJsonFriendly(v, 'other'));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonFriendly(v, 'other')]));
  }
  return value;
}

async function datasetIds(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(PARQUET))
    .map((e) => e.name.slice(0, -PARQUET.length))
    .filter((id) => IDENTIFIER_PATTERN.test(id))
    .sort();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one statement that already passed `assertReadOnlySql` on a sandboxed connection: a timer
 * interrupts it past the timeout, rows are streamed and only maxRows + 1 kept.
 */
export async function runReadOnlySql(
  connection: DuckDBConnection,
  sql: string,
  limits: Partial<QueryLimits> = {},
): Promise<QueryResult> {
  const { timeoutMs, maxRows } = { ...DEFAULT_QUERY_LIMITS, ...limits };
  const started = performance.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    connection.interrupt();
  }, timeoutMs);
  try {
    const reader = await connection.streamAndReadUntil(sql, maxRows + 1);
    const columns = reader.columnNames().map((name, i) => ({
      name,
      type: duckDbColumnType(reader.columnType(i).toString()),
    }));
    const all = reader.getRowsJS();
    const rows = all.slice(0, maxRows).map((row) => row.map((value, i) => toJsonFriendly(value, columns[i]!.type)));
    return { columns, rows, truncated: all.length > maxRows, durationMs: Math.round(performance.now() - started) };
  } catch (error) {
    if (timedOut || /INTERRUPT/i.test(messageOf(error))) throw new QueryTimeoutError(timeoutMs);
    throw new QueryFailedError(messageOf(error));
  } finally {
    clearTimeout(timer);
  }
}

export function createDuckDbDriver({ directory }: { directory: string }): DataSourceDriver {
  let opened: Promise<{ instance: DuckDBInstance; connection: DuckDBConnection; ids: string[] }> | undefined;

  async function open() {
    const ids = await datasetIds(directory);
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
      const files = ids.map((id) => duckDbPath(path.join(directory, `${id}${PARQUET}`)));
      for (const [i, id] of ids.entries()) {
        await connection.run(`CREATE VIEW ${quoteIdentifier(id)} AS SELECT * FROM read_parquet(${sqlString(files[i]!)})`);
      }
      // Exactly the Dataset files stay readable (through their views); nothing else on disk is.
      if (files.length > 0) await connection.run(`SET allowed_paths = [${files.map(sqlString).join(', ')}]`);
      await connection.run('SET enable_external_access = false');
      await connection.run('SET lock_configuration = true');
    } catch (error) {
      connection.closeSync();
      instance.closeSync();
      throw error;
    }
    return { instance, connection, ids };
  }

  /** Opened once per driver; a failed open is retried on the next call. */
  function session() {
    opened ??= open().catch((error: unknown) => {
      opened = undefined;
      throw error;
    });
    return opened;
  }

  return {
    dialect: DUCKDB_DIALECT,

    async testConnection() {
      try {
        await access(directory, constants.R_OK);
        await session();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: `The uploads folder ${directory} cannot be read: ${messageOf(error)}` };
      }
    },

    async introspect(): Promise<IntrospectedDataset[]> {
      const { connection, ids } = await session();
      const datasets: IntrospectedDataset[] = [];
      for (const id of ids) {
        const described = await connection.runAndReadAll(`DESCRIBE ${quoteIdentifier(id)}`);
        datasets.push({
          id,
          name: id,
          schema: null,
          kind: 'sheet',
          columns: described.getRowObjectsJS().map((row) => ({
            name: String(row.column_name),
            type: duckDbColumnType(String(row.column_type)),
            nativeType: String(row.column_type),
            nullable: row.null !== 'NO',
          })),
        });
      }
      return datasets;
    },

    async execute(query, limits = {}): Promise<QueryResult> {
      if (typeof query !== 'string') throw new QueryRejectedError('Uploads take a SQL string.');
      const sql = assertReadOnlySql(query, 'duckdb');
      const { connection } = await session();
      return runReadOnlySql(connection, sql, limits);
    },

    async close() {
      const current = opened;
      opened = undefined;
      if (!current) return;
      try {
        const { instance, connection } = await current;
        connection.closeSync();
        instance.closeSync();
      } catch {
        // Never opened: nothing to release.
      }
    },
  };
}
