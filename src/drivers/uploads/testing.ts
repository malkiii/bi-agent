/**
 * Test helpers for the Uploads driver: a throwaway uploads directory per caller, and a way
 * to write Parquet files into it without going through the driver.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

export interface UploadsTestDirectory {
  directory: string;
  /** Writes `<name>.parquet` from a DuckDB SELECT. */
  writeParquet(name: string, select: string): Promise<void>;
  /** Runs SQL in a fresh in-memory DuckDB (outside the driver) and returns row arrays as JSON. */
  sql(query: string): Promise<unknown[][]>;
  remove(): Promise<void>;
}

/** The contract fixture as a DuckDB SELECT: `orders(id integer, region string, amount number)`. */
export const CONTRACT_FIXTURE_SELECT = `
  SELECT * FROM (VALUES (1, 'north', 10.5::DOUBLE), (2, 'south', 20::DOUBLE), (3, 'north', 7.25::DOUBLE))
    AS t(id, region, amount)`;

export async function createUploadsTestDirectory(): Promise<UploadsTestDirectory> {
  const directory = await mkdtemp(path.join(tmpdir(), 'botley-uploads-'));

  async function sql(query: string): Promise<unknown[][]> {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
      const reader = await connection.runAndReadAll(query);
      return reader.getRowsJson() as unknown[][];
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  }

  return {
    directory,
    sql,
    async writeParquet(name, select) {
      const target = path.join(directory, `${name}.parquet`).replaceAll("'", "''");
      await sql(`COPY (${select}) TO '${target}' (FORMAT parquet)`);
    },
    async remove() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}
