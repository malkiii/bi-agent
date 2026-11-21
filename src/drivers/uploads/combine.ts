/**
 * The ResultCombiner behind `combineResults`: loads earlier query results (from any Data
 * Sources) into a fresh in-memory DuckDB, one table per result, and runs one read-only
 * statement over them. Same layers as the Uploads driver: `assertReadOnlySql`, then a sandbox
 * with external access off and the configuration locked, then a timeout. The database is
 * closed after every call, so nothing outlives it.
 */
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { ColumnType, QueryResult } from '@/core/data-sources/driver';
import type { ResultCombiner } from '@/core/ports';
import { assertReadOnlySql } from '../sql/read-only-guard';
import { quoteIdentifier, runReadOnlySql } from './duckdb';

const COMBINE_GUIDANCE =
  'DuckDB SQL. Write one SELECT or WITH statement. Each result is a table named by its resultId (double-quote it if it ' +
  'is not a plain identifier); column names are as the result returned them. Use JOIN ... USING (col), UNION ALL, ' +
  "GROUP BY ALL, date_trunc('month', d). Reading files is not allowed.";

/** How each engine-independent column type is stored; everything else is kept as text. */
const DUCKDB_TYPES: Partial<Record<ColumnType, string>> = {
  integer: 'HUGEINT',
  number: 'DOUBLE',
  boolean: 'BOOLEAN',
  date: 'DATE',
  datetime: 'TIMESTAMP',
};

export function createDuckDbResultCombiner(): ResultCombiner {
  return {
    guidance: COMBINE_GUIDANCE,

    async combine(tables, query) {
      const sql = assertReadOnlySql(query, 'duckdb');
      const instance = await DuckDBInstance.create(':memory:');
      const connection = await instance.connect();
      try {
        for (const [name, result] of Object.entries(tables)) await load(connection, name, result);
        await connection.run('SET enable_external_access = false');
        await connection.run('SET lock_configuration = true');
        return await runReadOnlySql(connection, sql);
      } finally {
        connection.closeSync();
        instance.closeSync();
      }
    },
  };
}

/**
 * Appends every value as text into a staging table, then casts each column to its type,
 * which handles numbers sent as exact text, dates as strings or `Date`s, and JSON values alike.
 */
async function load(connection: DuckDBConnection, name: string, result: QueryResult) {
  const staging = `staging_${Math.random().toString(36).slice(2)}`;
  const columns = result.columns.map((c, i) => ({ ...c, staged: `c${i}` }));
  await connection.run(
    `CREATE TEMP TABLE ${staging} (${columns.map((c) => `${c.staged} VARCHAR`).join(', ') || 'empty VARCHAR'})`,
  );
  if (columns.length > 0) {
    const appender = await connection.createAppender(staging);
    for (const row of result.rows) {
      columns.forEach((_, i) => {
        const text = asText(row[i]);
        if (text === null) appender.appendNull();
        else appender.appendVarchar(text);
      });
      appender.endRow();
    }
    appender.flushSync();
    appender.closeSync();
  }
  const select = columns
    .map((c) => {
      const type = DUCKDB_TYPES[c.type];
      return `${type ? `TRY_CAST(${c.staged} AS ${type})` : c.staged} AS ${quoteIdentifier(c.name)}`;
    })
    .join(', ');
  await connection.run(`CREATE TEMP TABLE ${quoteIdentifier(name)} AS SELECT ${select || 'NULL AS empty WHERE false'} FROM ${staging}`);
  await connection.run(`DROP TABLE ${staging}`);
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  // `YYYY-MM-DD HH:MM:SS.sss`, which DuckDB casts to TIMESTAMP (UTC) without a time zone extension.
  if (value instanceof Date) return value.toISOString().replace('T', ' ').replace('Z', '');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
