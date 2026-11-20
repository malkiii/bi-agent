/**
 * Uploads driver (ADR 0003): every `<dataset>.parquet` file in the uploads directory is one
 * Dataset, queried with SQL through a fresh in-memory DuckDB per call. Read-only enforcement:
 * 1. assertReadOnlySql(query, 'duckdb'): one SELECT/WITH, no COPY/ATTACH/SET/INSTALL/... words.
 * 2. The DuckDB instance is in-memory, sees each Dataset as a view over its Parquet file, and is
 *    locked down before the query runs: `allowed_directories` = the uploads directory,
 *    `enable_external_access = false` (no other files, URLs or extension installs) and
 *    `lock_configuration = true` so the query cannot undo it.
 * 3. A timer interrupts the query at the timeout; only maxRows + 1 rows are materialised.
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
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
} from '@/core/data-sources/driver';
import { assertReadOnlySql } from '../sql/read-only-guard';

export interface UploadsConnection {
  /** The shared uploads volume (`/data/uploads` in compose). */
  directory: string;
}

export const UPLOADS_DIALECT: Dialect = {
  language: 'sql',
  flavour: 'duckdb',
  guidance:
    'DuckDB SQL over uploaded spreadsheets; each Dataset is a table named by its id. Write one SELECT or WITH ' +
    'statement. Quote column names with spaces or capitals in double quotes (e.g. "Deal Name"), use single quotes ' +
    'for strings, date_trunc(\'month\', d) for periods, and ::DOUBLE casts for division.',
};

const PARQUET = '.parquet';

/** Maps a DuckDB type name (`BIGINT`, `DECIMAL(10,2)`, `TIMESTAMP WITH TIME ZONE`, ...) to a ColumnType. */
export function duckdbColumnType(nativeType: string): ColumnType {
  const t = nativeType.toUpperCase();
  if (/^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT)$/.test(t)) {
    return 'integer';
  }
  if (/^(FLOAT|DOUBLE|REAL)$/.test(t) || t.startsWith('DECIMAL')) return 'number';
  if (t === 'VARCHAR' || t === 'UUID') return 'string';
  if (t === 'BOOLEAN') return 'boolean';
  if (t === 'DATE') return 'date';
  if (t.startsWith('TIMESTAMP')) return 'datetime';
  if (t === 'JSON') return 'json';
  return 'other';
}

/** Numbers as JS numbers only when that is exact; otherwise the engine's text. */
function exactNumber(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (/^-?\d+$/.test(value)) return Number.isSafeInteger(n) ? n : value;
  const digits = value.replace(/^-/, '').replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  return digits.length <= 15 ? n : value;
}

const sqlString = (text: string) => `'${text.replaceAll("'", "''")}'`;
const sqlIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Dataset files directly inside the directory; staging and temp files start with a dot. */
export async function listDatasetFiles(directory: string): Promise<{ id: string; file: string }[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(PARQUET) && !e.name.startsWith('.'))
    .map((e) => ({ id: e.name.slice(0, -PARQUET.length), file: path.join(directory, e.name) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

interface Session {
  connection: DuckDBConnection;
  close(): void;
}

/** A fresh in-memory DuckDB with one view per Dataset, locked to the uploads directory. */
async function openSession(directory: string): Promise<Session> {
  const files = await listDatasetFiles(directory);
  const instance = await DuckDBInstance.create(':memory:', { threads: '2', memory_limit: '1GB' });
  const connection = await instance.connect();
  const close = () => {
    connection.closeSync();
    instance.closeSync();
  };
  try {
    const root = path.resolve(directory) + path.sep;
    await connection.run(`SET allowed_directories = [${sqlString(root)}]`);
    await connection.run('SET enable_external_access = false');
    for (const { id, file } of files) {
      await connection.run(`CREATE VIEW ${sqlIdent(id)} AS SELECT * FROM read_parquet(${sqlString(file)})`);
    }
    await connection.run('SET lock_configuration = true');
    return { connection, close };
  } catch (error) {
    close();
    throw error;
  }
}

async function describeFile(connection: DuckDBConnection, file: string) {
  const reader = await connection.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet(${sqlString(file)})`);
  return (reader.getRowObjectsJson() as { column_name: string; column_type: string }[]).map((r) => ({
    name: r.column_name,
    type: duckdbColumnType(r.column_type),
    nativeType: r.column_type,
    nullable: true,
  }));
}

export function createUploadsDriver({ directory }: UploadsConnection): DataSourceDriver {
  return {
    dialect: UPLOADS_DIALECT,

    async testConnection() {
      try {
        const info = await stat(directory);
        if (!info.isDirectory()) return { ok: false, error: `The uploads path "${directory}" is not a directory.` };
        const session = await openSession(directory);
        session.close();
        return { ok: true };
      } catch (error) {
        const e = error as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') return { ok: false, error: `The uploads directory "${directory}" does not exist.` };
        if (e.code === 'EACCES') return { ok: false, error: `Botley cannot read the uploads directory "${directory}".` };
        return { ok: false, error: e.message || String(error) };
      }
    },

    async introspect() {
      const files = await listDatasetFiles(directory);
      const instance = await DuckDBInstance.create(':memory:');
      const connection = await instance.connect();
      try {
        const datasets: IntrospectedDataset[] = [];
        for (const { id, file } of files) {
          datasets.push({ id, name: id, schema: null, kind: 'sheet', columns: await describeFile(connection, file) });
        }
        return datasets;
      } finally {
        connection.closeSync();
        instance.closeSync();
      }
    },

    async execute(query, limits) {
      if (typeof query !== 'string') throw new QueryRejectedError('Uploads Data Sources take a SQL string.');
      const sql = assertReadOnlySql(query, 'duckdb');
      const { timeoutMs, maxRows } = { ...DEFAULT_QUERY_LIMITS, ...limits };
      const started = performance.now();

      let session: Session;
      try {
        session = await openSession(directory);
      } catch (error) {
        throw new QueryFailedError(`The uploads directory cannot be read: ${(error as Error).message}`);
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        session.connection.interrupt();
      }, timeoutMs);
      try {
        const reader = await session.connection.streamAndReadUntil(sql, Math.floor(maxRows) + 1);
        const types = reader.columnTypes().map((t) => duckdbColumnType(t.toString()));
        const all = reader.getRowsJson() as unknown[][];
        const truncated = all.length > maxRows;
        const rows = (truncated ? all.slice(0, maxRows) : all).map((row) =>
          row.map((value, i) => (types[i] === 'integer' || types[i] === 'number' ? exactNumber(value) : value)),
        );
        return {
          columns: reader.columnNames().map((name, i) => ({ name, type: types[i]! })),
          rows,
          truncated,
          durationMs: Math.round(performance.now() - started),
        };
      } catch (error) {
        if (timedOut || /interrupt/i.test((error as Error).message)) throw new QueryTimeoutError(timeoutMs);
        throw new QueryFailedError((error as Error).message);
      } finally {
        clearTimeout(timer);
        session.close();
      }
    },

    async close() {
      // Every call opens and closes its own in-memory DuckDB; nothing stays open.
    },
  };
}

const uploadsConfigSchema = z.object({ directory: z.string().trim().min(1, 'Directory is required') });

/**
 * The built-in "Uploads" Data Source kind. It is managed by the App Core (`core.uploads`), which
 * creates the single Uploads Data Source with the configured directory; admins cannot add, edit
 * or delete it from the form.
 */
export const uploadsKind: DriverKind<z.infer<typeof uploadsConfigSchema>, Record<string, string>> = {
  kind: 'uploads',
  label: 'Uploads',
  managed: true,
  fields: [],
  configSchema: uploadsConfigSchema,
  secretsSchema: z.record(z.string(), z.string()),
  create: (config) => createUploadsDriver({ directory: config.directory }),
};
