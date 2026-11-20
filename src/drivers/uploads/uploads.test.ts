import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { QueryFailedError, QueryRejectedError, type DataSourceDriver } from '@/core/data-sources/driver';
import { describeDriverContract } from '../contract/driver-contract';
import { createUploadsDriver } from './uploads';
import { CONTRACT_FIXTURE_SELECT, createUploadsTestDirectory, type UploadsTestDirectory } from './testing';

describeDriverContract({
  kind: 'uploads',
  queries: {
    ordersById: 'SELECT id, region, amount FROM orders ORDER BY id',
    twentyFiveRows: 'SELECT range AS n FROM range(25)',
    slow: 'SELECT sum(hash(i)) FROM range(1000000000000) t(i)',
    forbidden: {
      INSERT: "INSERT INTO orders VALUES (4, 'east', 1)",
      'CREATE TABLE': 'CREATE TABLE evil AS SELECT * FROM orders',
      'DROP VIEW': 'DROP VIEW orders',
      'COPY TO a file': "COPY (SELECT * FROM orders) TO 'orders.parquet' (FORMAT parquet)",
      'multiple statements': 'SELECT 1; DROP VIEW orders',
      ATTACH: "ATTACH 'evil.duckdb' AS evil",
      SET: 'SET enable_external_access = true',
      PRAGMA: 'PRAGMA database_list',
      'INSTALL extension': 'INSTALL httpfs',
      'empty query': '  ',
      'not a string': { find: 'orders' },
    },
  },
  async setup() {
    const dir = await createUploadsTestDirectory();
    await dir.writeParquet('orders', CONTRACT_FIXTURE_SELECT);
    return {
      driver: createUploadsDriver({ directory: dir.directory }),
      unreachableDriver: createUploadsDriver({ directory: path.join(dir.directory, 'missing') }),
      async countOrders() {
        const file = path.join(dir.directory, 'orders.parquet').replaceAll("'", "''");
        const [[n]] = (await dir.sql(`SELECT count(*)::INTEGER FROM read_parquet('${file}')`)) as [[number]];
        return n;
      },
      teardown: () => dir.remove(),
    };
  },
});

describe('uploads driver', () => {
  let dir: UploadsTestDirectory;
  let outside: UploadsTestDirectory;
  let driver: DataSourceDriver;

  beforeAll(async () => {
    [dir, outside] = await Promise.all([createUploadsTestDirectory(), createUploadsTestDirectory()]);
    await dir.writeParquet('orders', CONTRACT_FIXTURE_SELECT);
    await dir.writeParquet(
      'deals',
      `SELECT 9007199254740993::BIGINT AS big, true AS won, DATE '2026-01-05' AS closed_on,
              TIMESTAMP '2026-01-05 10:00:00' AS closed_at, 12.345::DECIMAL(10,3) AS fee, 'x' AS "Deal Name"`,
    );
    await outside.writeParquet('secret', "SELECT 'classified' AS s");
    driver = createUploadsDriver({ directory: dir.directory });
  });
  afterAll(async () => {
    await driver.close();
    await Promise.all([dir.remove(), outside.remove()]);
  });

  test('each Parquet file is a sheet Dataset named after the file', async () => {
    const datasets = await driver.introspect();

    expect(datasets.map((d) => d.id).sort()).toEqual(['deals', 'orders']);
    expect(datasets.find((d) => d.id === 'deals')).toMatchObject({
      name: 'deals',
      schema: null,
      kind: 'sheet',
      columns: [
        { name: 'big', type: 'integer', nativeType: 'BIGINT' },
        { name: 'won', type: 'boolean', nativeType: 'BOOLEAN' },
        { name: 'closed_on', type: 'date', nativeType: 'DATE' },
        { name: 'closed_at', type: 'datetime', nativeType: 'TIMESTAMP' },
        { name: 'fee', type: 'number', nativeType: 'DECIMAL(10,3)' },
        { name: 'Deal Name', type: 'string', nativeType: 'VARCHAR' },
      ],
    });
  });

  test('values keep their exact meaning: big integers stay text, dates stay as written', async () => {
    const result = await driver.execute('SELECT big, won, closed_on, closed_at, fee, "Deal Name" FROM deals');

    expect(result.columns.map((c) => c.type)).toEqual(['integer', 'boolean', 'date', 'datetime', 'number', 'string']);
    expect(result.rows).toEqual([['9007199254740993', true, '2026-01-05', '2026-01-05 10:00:00', 12.345, 'x']]);
  });

  test('files outside the uploads directory cannot be read', async () => {
    const secret = path.join(outside.directory, 'secret.parquet').replaceAll("'", "''");

    await expect(driver.execute(`SELECT * FROM read_parquet('${secret}')`)).rejects.toThrow(QueryFailedError);
  });

  test('engine errors come back for the model to fix', async () => {
    await expect(driver.execute('SELECT nope FROM orders')).rejects.toThrow(QueryFailedError);
  });

  test('non-SQL queries are refused', async () => {
    await expect(driver.execute({ find: 'orders' })).rejects.toThrow(QueryRejectedError);
  });
});
