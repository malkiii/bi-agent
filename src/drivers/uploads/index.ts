/**
 * Uploads backend (ADR 0003) for one directory on the shared volume:
 *   <root>/datasets/<datasetId>.parquet   one Parquet file per uploaded Dataset
 *   <root>/staging/<id>.upload            files waiting for the member to confirm the preview
 * `kind` is the Uploads Data Source kind (queries through DuckDB); `storage` is the App Core's
 * UploadStorage port. Both `web` and `worker` build it over the same directory.
 */
import { randomUUID } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DuckDBDateValue, DuckDBInstance, DuckDBTimestampValue, type DuckDBAppender } from '@duckdb/node-api';
import { z } from 'zod';
import type { DriverKind } from '@/core/data-sources/driver';
import type { StoredColumn, TypedTable, UploadStorage } from '@/core/ports';
import { IDENTIFIER_PATTERN } from '@/core/uploads/column-types';
import { UPLOADS_KIND } from '@/core/uploads/uploads';
import { createDuckDbDriver, duckDbColumnType, duckDbPath, quoteIdentifier, sqlString } from './duckdb';

/** Staged files older than this are deleted on the next upload. */
const STAGED_MAX_AGE_MS = 24 * 60 * 60_000;
const STAGED_ID = /^[0-9a-f-]{36}$/;

const NATIVE_TYPES: Record<StoredColumn['type'], string> = {
  string: 'VARCHAR',
  integer: 'BIGINT',
  number: 'DOUBLE',
  boolean: 'BOOLEAN',
  date: 'DATE',
  datetime: 'TIMESTAMP',
};

const MS_PER_DAY = 86_400_000;

export interface UploadsBackend {
  kind: DriverKind<Record<string, never>, Record<string, never>>;
  storage: UploadStorage;
}

export function createUploadsBackend(root: string): UploadsBackend {
  const datasetsDir = path.join(root, 'datasets');
  const stagingDir = path.join(root, 'staging');
  /** Writes to one Dataset run one after another (append reads the file it replaces). */
  const locks = new Map<string, Promise<unknown>>();

  const datasetFile = (id: string) => {
    if (!IDENTIFIER_PATTERN.test(id)) throw new Error(`Invalid Dataset id "${id}".`);
    return path.join(datasetsDir, `${id}.parquet`);
  };
  const stagedFile = (id: string) => {
    if (!STAGED_ID.test(id)) throw new Error(`Invalid staged upload id "${id}".`);
    return path.join(stagingDir, `${id}.upload`);
  };

  function serialised<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    locks.set(id, next);
    void next.finally(() => {
      if (locks.get(id) === next) locks.delete(id);
    }).catch(() => undefined);
    return next;
  }

  async function pruneStaged() {
    const now = Date.now();
    for (const name of await readdir(stagingDir).catch(() => [] as string[])) {
      const file = path.join(stagingDir, name);
      const info = await stat(file).catch(() => null);
      if (info && now - info.mtimeMs > STAGED_MAX_AGE_MS) await rm(file, { force: true });
    }
  }

  async function write(id: string, table: TypedTable, mode: 'create' | 'replace' | 'append'): Promise<StoredColumn[] | null> {
    await mkdir(datasetsDir, { recursive: true });
    const target = datasetFile(id);
    // Not a .parquet name, so the driver never lists a half-written file.
    const temp = path.join(datasetsDir, `.${id}.${randomUUID()}.tmp`);
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
      const columns = table.columns.map((c) => `${quoteIdentifier(c.name)} ${NATIVE_TYPES[c.type]}`).join(', ');
      await connection.run(`CREATE TABLE incoming (${columns})`);
      const appender = await connection.createAppender('incoming');
      for (const row of table.rows) {
        table.columns.forEach((column, i) => appendValue(appender, column.type, row[i] ?? null));
        appender.endRow();
      }
      appender.flushSync();
      appender.closeSync();

      const source =
        mode === 'append'
          ? `SELECT * FROM read_parquet(${sqlString(duckDbPath(target))}) UNION ALL BY NAME SELECT * FROM incoming`
          : 'SELECT * FROM incoming';
      await connection.run(`COPY (${source}) TO ${sqlString(duckDbPath(temp))} (FORMAT parquet)`);
      const described = await connection.runAndReadAll(
        `DESCRIBE SELECT * FROM read_parquet(${sqlString(duckDbPath(temp))})`,
      );
      const stored = described.getRowObjectsJS().map((row) => ({
        name: String(row.column_name),
        type: duckDbColumnType(String(row.column_type)) as StoredColumn['type'],
        nativeType: String(row.column_type),
      }));
      if (mode === 'create') {
        // A hard link fails if the target exists, so two processes can't both create the Dataset.
        try {
          await link(temp, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
          throw error;
        } finally {
          await rm(temp, { force: true });
        }
        return stored;
      }
      // The atomic swap: readers see the old file or the new one, never a partial write.
      await rename(temp, target);
      return stored;
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  }

  const storage: UploadStorage = {
    async stage(content) {
      await mkdir(stagingDir, { recursive: true });
      await pruneStaged();
      const id = randomUUID();
      await writeFile(stagedFile(id), content);
      return id;
    },

    async readStaged(id) {
      try {
        return new Uint8Array(await readFile(stagedFile(id)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },

    async discardStaged(id) {
      await rm(stagedFile(id), { force: true });
    },

    writeDataset: (id, table, mode) => serialised(id, () => write(id, table, mode)),

    deleteDataset: (id) => serialised(id, () => rm(datasetFile(id), { force: true })),
  };

  const kind: UploadsBackend['kind'] = {
    kind: UPLOADS_KIND,
    label: 'Uploads',
    fields: [],
    managed: true,
    configSchema: z.object({}) as unknown as z.ZodType<Record<string, never>>,
    secretsSchema: z.object({}) as unknown as z.ZodType<Record<string, never>>,
    create: () => createDuckDbDriver({ directory: datasetsDir }),
  };

  return { kind, storage };
}

function appendValue(appender: DuckDBAppender, type: StoredColumn['type'], value: unknown) {
  if (value === null) return appender.appendNull();
  switch (type) {
    case 'string':
      return appender.appendVarchar(String(value));
    case 'integer':
      return appender.appendBigInt(BigInt(value as number));
    case 'number':
      return appender.appendDouble(value as number);
    case 'boolean':
      return appender.appendBoolean(value as boolean);
    case 'date':
      return appender.appendDate(new DuckDBDateValue(Math.floor((value as Date).getTime() / MS_PER_DAY)));
    case 'datetime':
      return appender.appendTimestamp(new DuckDBTimestampValue(BigInt((value as Date).getTime()) * 1000n));
  }
}
