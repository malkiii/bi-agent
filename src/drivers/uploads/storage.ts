/**
 * The production UploadStorage (ADR 0003): uploaded CSV/XLSX files become Parquet files on the
 * shared uploads volume, converted with an in-memory DuckDB.
 *
 *   <directory>/<datasetId>.parquet               one file per Dataset (what the driver queries)
 *   <directory>/.staging/<uploadId>/<n>.parquet   staged sheets, every column as text
 *   <directory>/.tmp-<uuid>.parquet               a file being written, renamed over the Dataset
 *
 * Writes go to a temp file in the same directory and are renamed into place, so readers see
 * either the old file or the new one, never a partial write. Writes to one Dataset are
 * serialised within the process (only `web` writes uploads).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import ExcelJS from 'exceljs';
import type { Column } from '@/core/data-sources/driver';
import {
  UploadConversionError,
  UploadFormatError,
  type StagedSheet,
  type UploadColumnType,
  type UploadStorage,
  type WrittenDataset,
} from '@/core/uploads/storage';
import { duckdbColumnType } from './uploads';

const SAMPLE_ROWS = 20;

const sqlString = (text: string) => `'${text.replaceAll("'", "''")}'`;
const sqlIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** The DuckDB type each choosable column type is stored as. */
const NATIVE: Record<UploadColumnType, string> = {
  string: 'VARCHAR',
  integer: 'BIGINT',
  number: 'DOUBLE',
  boolean: 'BOOLEAN',
  date: 'DATE',
  datetime: 'TIMESTAMP',
};

const INTEGER_TEXT = String.raw`^\s*[-+]?\d+\s*$`;
const NUMBER_TEXT = String.raw`^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$`;
const DATE_TEXT = String.raw`^\s*\d{4}-\d{2}-\d{2}\s*$`;
const DATETIME_TEXT = String.raw`^\s*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*$`;

/** SQL converting text column `c` to `nativeType`; NULL when the value does not fit. */
function convert(c: string, nativeType: string): string {
  const value = `trim(${c})`;
  switch (duckdbColumnType(nativeType)) {
    case 'string':
      return c;
    case 'integer':
      return `CASE WHEN regexp_matches(${c}, ${sqlString(INTEGER_TEXT)}) THEN TRY_CAST(${value} AS ${nativeType}) END`;
    case 'boolean':
      return `CASE lower(${value}) WHEN 'true' THEN true WHEN 'false' THEN false WHEN 'yes' THEN true WHEN 'no' THEN false END`;
    default:
      return `TRY_CAST(${value} AS ${nativeType})`;
  }
}

async function withDuckDb<T>(work: (connection: DuckDBConnection) => Promise<T>): Promise<T> {
  const instance = await DuckDBInstance.create(':memory:', { threads: '2' });
  const connection = await instance.connect();
  try {
    return await work(connection);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function rows(connection: DuckDBConnection, sql: string): Promise<unknown[][]> {
  return (await connection.runAndReadAll(sql)).getRowsJson() as unknown[][];
}

async function describe(connection: DuckDBConnection, file: string): Promise<Column[]> {
  const result = await rows(connection, `DESCRIBE SELECT * FROM read_parquet(${sqlString(file)})`);
  return result.map(([name, nativeType]) => ({
    name: String(name),
    type: duckdbColumnType(String(nativeType)),
    nativeType: String(nativeType),
    nullable: true,
  }));
}

/** Header cells become unique, non-empty column names (`column_3`, `Name_2`). */
export function columnNames(header: readonly (string | null)[]): string[] {
  const used = new Set<string>();
  return header.map((cell, i) => {
    const base = (cell ?? '').trim() || `column_${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}_${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** One sheet as text cells: row 0 is the header. */
type TextSheet = { name: string; cells: (string | null)[][] };

function pad(n: number) {
  return String(n).padStart(2, '0');
}

/** Excel cell values to text. Dates keep their wall-clock value (exceljs stores it as UTC). */
function cellText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
    const h = value.getUTCHours();
    const m = value.getUTCMinutes();
    const s = value.getUTCSeconds();
    return h || m || s ? `${date} ${pad(h)}:${pad(m)}:${pad(s)}` : date;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value === '' ? null : value;
  if ('error' in value) return null;
  if ('result' in value) return cellText((value.result ?? null) as ExcelJS.CellValue);
  if ('richText' in value) return value.richText.map((t) => t.text).join('') || null;
  if ('text' in value) return cellText(value.text as ExcelJS.CellValue);
  return null;
}

async function readWorkbook(bytes: Uint8Array): Promise<TextSheet[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw new UploadFormatError('This file could not be read as an XLSX workbook.');
  }
  return workbook.worksheets.map((sheet) => {
    const cells: (string | null)[][] = [];
    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const values = (row.values as ExcelJS.CellValue[]).slice(1).map(cellText);
      cells[rowNumber - 1] = values;
    });
    for (let i = 0; i < cells.length; i++) cells[i] ??= [];
    return { name: sheet.name, cells };
  });
}

export function createUploadStorage({ directory }: { directory: string }): UploadStorage {
  const root = path.resolve(directory);
  const stagingDir = (uploadId: string) => path.join(root, '.staging', uploadId);
  const stagedFile = (uploadId: string, index: number) => path.join(stagingDir(uploadId), `${index}.parquet`);
  const datasetFile = (datasetId: string) => path.join(root, `${datasetId}.parquet`);
  const locks = new Map<string, Promise<unknown>>();

  /** Serialises writes to one Dataset within this process. */
  function locked<T>(datasetId: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(datasetId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    locks.set(datasetId, next);
    void next.finally(() => {
      if (locks.get(datasetId) === next) locks.delete(datasetId);
    }).catch(() => {});
    return next;
  }

  /** Stages a raw table (all VARCHAR columns, header in the first row by rowid). */
  async function stageTable(
    connection: DuckDBConnection,
    table: string,
    uploadId: string,
    index: number,
    name: string,
  ): Promise<StagedSheet | null> {
    const rawColumns = (await rows(connection, `SELECT column_name FROM (DESCRIBE ${table})`)).map((r) => String(r[0]));
    const [headerRow] = (await rows(connection, `SELECT * FROM ${table} ORDER BY rowid LIMIT 1`)) as (string | null)[][];
    if (!headerRow) return null;

    // Drop columns with neither a header nor any value; drop rows with no values.
    const nonEmpty = await rows(
      connection,
      `SELECT ${rawColumns.map((c) => `count(${sqlIdent(c)})::INTEGER`).join(', ')} FROM ${table}`,
    );
    const keep = rawColumns.map((c, i) => ({ c, header: headerRow[i] ?? null })).filter((_, i) => Number(nonEmpty[0]![i]) > 0);
    if (keep.length === 0) return null;
    const names = columnNames(keep.map((k) => k.header));
    const anyValue = keep.map((k) => `${sqlIdent(k.c)} IS NOT NULL`).join(' OR ');

    const file = stagedFile(uploadId, index);
    await connection.run(
      `COPY (SELECT ${keep.map((k, i) => `NULLIF(${sqlIdent(k.c)}, '') AS ${sqlIdent(names[i]!)}`).join(', ')}
             FROM ${table} WHERE rowid > (SELECT min(rowid) FROM ${table}) AND (${anyValue}) ORDER BY rowid)
       TO ${sqlString(file)} (FORMAT parquet)`,
    );

    const source = `read_parquet(${sqlString(file)})`;
    const counts = names.map((n) => {
      const c = sqlIdent(n);
      return [
        `count(${c})`,
        `count(${convert(c, 'BIGINT')})`,
        `count(*) FILTER (regexp_matches(${c}, ${sqlString(NUMBER_TEXT)}))`,
        `count(${convert(c, 'BOOLEAN')})`,
        `count(*) FILTER (regexp_matches(${c}, ${sqlString(DATE_TEXT)}) AND ${convert(c, 'DATE')} IS NOT NULL)`,
        `count(*) FILTER (regexp_matches(${c}, ${sqlString(DATETIME_TEXT)}) AND ${convert(c, 'TIMESTAMP')} IS NOT NULL)`,
      ]
        .map((e) => `${e}::BIGINT`)
        .join(', ');
    });
    const [stats] = await rows(connection, `SELECT count(*)::BIGINT, ${counts.join(', ')} FROM ${source}`);
    const rowCount = Number(stats![0]);
    const columns = names.map((name, i) => {
      const [filled, integer, number, boolean, date, datetime] = stats!.slice(1 + i * 6, 7 + i * 6).map(Number) as [
        number, number, number, number, number, number,
      ];
      let type: UploadColumnType = 'string';
      if (filled > 0) {
        if (integer === filled) type = 'integer';
        else if (number === filled) type = 'number';
        else if (boolean === filled) type = 'boolean';
        else if (date === filled) type = 'date';
        else if (date + datetime === filled) type = 'datetime';
      }
      return { name, type };
    });
    const sampleRows = (await rows(connection, `SELECT * FROM ${source} LIMIT ${SAMPLE_ROWS}`)) as (string | null)[][];
    return { index, name, columns, rowCount, sampleRows };
  }

  async function loadTextSheet(connection: DuckDBConnection, table: string, sheet: TextSheet) {
    const width = Math.max(1, ...sheet.cells.map((r) => r.length));
    await connection.run(
      `CREATE TABLE ${table} (${Array.from({ length: width }, (_, i) => `c${i} VARCHAR`).join(', ')})`,
    );
    const appender = await connection.createAppender(table);
    for (const row of sheet.cells) {
      for (let i = 0; i < width; i++) {
        const value = row[i];
        if (value === null || value === undefined) appender.appendNull();
        else appender.appendVarchar(value);
      }
      appender.endRow();
    }
    appender.closeSync();
  }

  /** Finds a value that does not fit its column type, for a readable error. */
  async function firstMisfit(connection: DuckDBConnection, source: string, targets: { name: string; nativeType: string }[]) {
    for (const { name, nativeType } of targets) {
      const c = sqlIdent(name);
      const [bad] = await rows(
        connection,
        `SELECT ${c} FROM ${source} WHERE ${c} IS NOT NULL AND (${convert(c, nativeType)}) IS NULL LIMIT 1`,
      );
      if (bad) {
        const type = duckdbColumnType(nativeType);
        return new UploadConversionError(
          `Column "${name}" has the value "${String(bad[0])}", which is not ${type === 'integer' ? 'an' : 'a'} ${type}. ` +
            `Choose another type for "${name}" or fix the file.`,
        );
      }
    }
    return null;
  }

  /** Writes `select` to a temp file, then renames it over the Dataset file. */
  async function swapIn(connection: DuckDBConnection, datasetId: string, select: string): Promise<WrittenDataset> {
    const temp = path.join(root, `.tmp-${randomUUID()}.parquet`);
    try {
      await connection.run(`COPY (${select}) TO ${sqlString(temp)} (FORMAT parquet, COMPRESSION zstd)`);
      const [[count]] = (await rows(connection, `SELECT count(*)::BIGINT FROM read_parquet(${sqlString(temp)})`)) as [[string]];
      const columns = await describe(connection, temp);
      await rename(temp, datasetFile(datasetId));
      return { columns, rowCount: Number(count) };
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  return {
    directory: root,

    async stage(uploadId, file) {
      const extension = path.extname(file.name).toLowerCase();
      if (extension !== '.csv' && extension !== '.xlsx') {
        throw new UploadFormatError('Only CSV or XLSX files can be uploaded.');
      }
      const dir = stagingDir(uploadId);
      await mkdir(dir, { recursive: true });

      return withDuckDb(async (connection) => {
        const staged: StagedSheet[] = [];
        if (extension === '.csv') {
          const source = path.join(dir, 'source.csv');
          await writeFile(source, file.bytes);
          try {
            await connection.run(
              `CREATE TABLE raw AS SELECT * FROM read_csv(${sqlString(source)}, all_varchar = true, header = false,
                 null_padding = true, sample_size = -1)`,
            );
          } catch (error) {
            throw new UploadFormatError(`This file could not be read as CSV: ${(error as Error).message}`);
          } finally {
            await rm(source, { force: true });
          }
          const sheet = await stageTable(connection, 'raw', uploadId, 0, path.basename(file.name, path.extname(file.name)));
          if (sheet) staged.push(sheet);
        } else {
          const sheets = await readWorkbook(file.bytes);
          for (const [index, sheet] of sheets.entries()) {
            if (sheet.cells.length === 0) continue;
            const table = `sheet_${index}`;
            await loadTextSheet(connection, table, sheet);
            const result = await stageTable(connection, table, uploadId, index, sheet.name);
            if (result) staged.push(result);
          }
        }
        return staged;
      });
    },

    replace(uploadId, sheetIndex, datasetId, types) {
      return locked(datasetId, () =>
        withDuckDb(async (connection) => {
          const source = `read_parquet(${sqlString(stagedFile(uploadId, sheetIndex))})`;
          const names = (await describe(connection, stagedFile(uploadId, sheetIndex))).map((c) => c.name);
          if (names.length !== types.length) {
            throw new UploadConversionError(`Expected ${names.length} column types, got ${types.length}.`);
          }
          const targets = names.map((name, i) => ({ name, nativeType: NATIVE[types[i]!] }));
          const misfit = await firstMisfit(connection, source, targets);
          if (misfit) throw misfit;
          const select = targets.map(({ name, nativeType }) => `${convert(sqlIdent(name), nativeType)} AS ${sqlIdent(name)}`);
          return swapIn(connection, datasetId, `SELECT ${select.join(', ')} FROM ${source}`);
        }),
      );
    },

    append(uploadId, sheetIndex, datasetId) {
      return locked(datasetId, () =>
        withDuckDb(async (connection) => {
          const source = `read_parquet(${sqlString(stagedFile(uploadId, sheetIndex))})`;
          const existingFile = datasetFile(datasetId);
          const existing = await describe(connection, existingFile);
          const misfit = await firstMisfit(connection, source, existing);
          if (misfit) throw misfit;
          const select = existing.map(({ name, nativeType }) => `${convert(sqlIdent(name), nativeType)} AS ${sqlIdent(name)}`);
          return swapIn(
            connection,
            datasetId,
            `SELECT * FROM read_parquet(${sqlString(existingFile)}) UNION ALL SELECT ${select.join(', ')} FROM ${source}`,
          );
        }),
      );
    },

    remove(datasetId) {
      return locked(datasetId, async () => {
        await unlink(datasetFile(datasetId)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      });
    },

    async discard(uploadId) {
      await rm(stagingDir(uploadId), { recursive: true, force: true });
    },
  };
}
