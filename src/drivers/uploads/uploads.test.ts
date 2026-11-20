import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { QueryFailedError, type DataSourceDriver } from '@/core/data-sources/driver';
import { describeDriverContract } from '../contract/driver-contract';
import { createDuckDbDriver } from './duckdb';
import { countParquetRows, writeContractFixture } from './testing';

describeDriverContract({
  kind: 'uploads',
  queries: {
    ordersById: 'SELECT id, region, amount FROM orders ORDER BY id',
    twentyFiveRows: 'SELECT range AS n FROM range(25)',
    slow: 'SELECT sum(a.range * b.range) FROM range(100000000) a, range(100000000) b',
    forbidden: {
      INSERT: "INSERT INTO orders VALUES (4, 'east', 1)",
      UPDATE: 'UPDATE orders SET amount = 0',
      DELETE: 'DELETE FROM orders',
      'DROP VIEW': 'DROP VIEW orders',
      'CREATE TABLE': 'CREATE TABLE evil AS SELECT * FROM orders',
      COPY: "COPY orders TO 'orders.csv'",
      ATTACH: "ATTACH 'evil.duckdb'",
      INSTALL: 'INSTALL httpfs',
      SET: 'SET enable_external_access = true',
      PRAGMA: 'PRAGMA database_list',
      'multiple statements': 'SELECT 1; DROP VIEW orders',
      'empty query': '   ',
      'not a string': { find: 'orders' },
    },
  },
  async setup() {
    const directory = await mkdtemp(path.join(tmpdir(), 'uploads-contract-'));
    await writeContractFixture(directory);
    return {
      driver: createDuckDbDriver({ directory }),
      unreachableDriver: createDuckDbDriver({ directory: path.join(directory, 'missing') }),
      countOrders: () => countParquetRows(path.join(directory, 'orders.parquet')),
      teardown: () => rm(directory, { recursive: true, force: true }),
    };
  },
});

describe('uploads driver', () => {
  let directory: string;
  let driver: DataSourceDriver;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'uploads-driver-'));
    await writeContractFixture(directory);
    await writeFile(path.join(directory, 'secret.csv'), 'password\nhunter2\n');
    driver = createDuckDbDriver({ directory });
  });
  afterAll(async () => {
    await driver.close();
    await rm(directory, { recursive: true, force: true });
  });

  test('queries cannot read files, even next to the Datasets', async () => {
    const secret = path.join(directory, 'secret.csv').replaceAll('\\', '/');

    await expect(driver.execute(`SELECT * FROM read_csv('${secret}')`)).rejects.toThrow(QueryFailedError);
    await expect(driver.execute(`SELECT * FROM '${secret}'`)).rejects.toThrow(QueryFailedError);
    await expect(driver.execute(`SELECT * FROM glob('${directory.replaceAll('\\', '/')}/*')`)).rejects.toThrow(
      QueryFailedError,
    );
  });

  test('result values are JSON-friendly: dates as text, big integers as text', async () => {
    const result = await driver.execute(
      "SELECT DATE '2026-01-05' AS d, TIMESTAMP '2026-01-05 10:00:00' AS ts, 9007199254740993::BIGINT AS big, 2::BIGINT AS small",
    );

    expect(result.columns).toEqual([
      { name: 'd', type: 'date' },
      { name: 'ts', type: 'datetime' },
      { name: 'big', type: 'integer' },
      { name: 'small', type: 'integer' },
    ]);
    expect(result.rows).toEqual([['2026-01-05', new Date('2026-01-05T10:00:00Z'), '9007199254740993', 2]]);
  });

  test('engine errors come back readable, for the model to correct', async () => {
    await expect(driver.execute('SELECT nope FROM orders')).rejects.toThrow(/nope/);
  });
});
