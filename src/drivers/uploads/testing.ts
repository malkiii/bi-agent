/** Test helpers for the Uploads driver: write and inspect Parquet files with DuckDB directly. */
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { duckDbPath, sqlString } from './duckdb';

async function withDuckDb<T>(work: (run: (sql: string) => Promise<unknown[][]>) => Promise<T>): Promise<T> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    return await work(async (sql) => (await connection.runAndReadAll(sql)).getRowsJS() as unknown[][]);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/** Writes the contract fixture as `orders.parquet` in `directory`. */
export function writeContractFixture(directory: string): Promise<void> {
  const file = sqlString(duckDbPath(path.join(directory, 'orders.parquet')));
  return withDuckDb(async (run) => {
    await run(`
      COPY (
        SELECT id::INTEGER AS id, region::VARCHAR AS region, amount::DOUBLE AS amount
        FROM (VALUES (1, 'north', 10.5), (2, 'south', 20), (3, 'north', 7.25)) t(id, region, amount)
      ) TO ${file} (FORMAT parquet)`);
  });
}

export function countParquetRows(file: string): Promise<number> {
  return withDuckDb(async (run) => {
    const rows = await run(`SELECT count(*) FROM read_parquet(${sqlString(duckDbPath(file))})`);
    return Number(rows[0]![0]);
  });
}
