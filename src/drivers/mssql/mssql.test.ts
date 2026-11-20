import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { QueryFailedError, QueryRejectedError, type DataSourceDriver } from '@/core/data-sources/driver';
import { describeDriverContract } from '../contract/driver-contract';
import { createMssqlDriver } from './mssql';
import { startTestServers } from '../sql/test-server';
import { CONTRACT_FIXTURE_SQL, createMssqlTestDatabase, type MssqlTestDatabase } from './testing';

startTestServers('mssql');

const COUNT_TO = (n: number) =>
  `WITH n AS (SELECT 1 AS i UNION ALL SELECT i + 1 FROM n WHERE i < ${n}) SELECT i FROM n OPTION (MAXRECURSION 0)`;

describeDriverContract({
  kind: 'mssql',
  queries: {
    ordersById: 'SELECT id, region, amount FROM orders ORDER BY id',
    twentyFiveRows: COUNT_TO(25),
    // WAITFOR is refused by the guard, so burn CPU instead: counting to 100 million takes far longer than 5 s.
    slow:
      'WITH n AS (SELECT CAST(1 AS bigint) AS i UNION ALL SELECT i + 1 FROM n WHERE i < 100000000) ' +
      'SELECT count_big(*) FROM n OPTION (MAXRECURSION 0)',
    forbidden: {
      INSERT: "INSERT INTO orders VALUES (4, 'east', 1)",
      UPDATE: 'UPDATE orders SET amount = 0',
      DELETE: 'DELETE FROM orders',
      'DROP TABLE': 'DROP TABLE orders',
      'CREATE TABLE': 'CREATE TABLE evil (id int)',
      TRUNCATE: 'TRUNCATE TABLE orders',
      MERGE: "MERGE orders AS t USING (SELECT 1 AS id) AS s ON t.id = s.id WHEN MATCHED THEN DELETE;",
      'multiple statements': 'SELECT 1; DELETE FROM orders',
      'a second statement without a semicolon': 'SELECT 1 DELETE FROM orders',
      'a second statement on a new line': 'SELECT * FROM orders\nDELETE FROM orders',
      EXEC: "SELECT 1 EXEC('DELETE FROM orders')",
      'SELECT INTO': 'SELECT * INTO evil FROM orders',
      'SELECT INTO a temp table': 'SELECT * INTO #evil FROM orders',
      OPENROWSET: "SELECT * FROM OPENROWSET('SQLNCLI', 'Server=.;Trusted_Connection=yes;', 'SELECT 1')",
      OPENQUERY: "SELECT * FROM OPENQUERY(self, 'DELETE FROM orders')",
      WAITFOR: "SELECT 1 WAITFOR DELAY '00:00:10'",
      'COMMIT inside the rolled-back transaction': 'SELECT 1 COMMIT',
      'a bracketed name hiding nothing': 'SELECT [x]]] FROM orders DELETE FROM orders',
      'empty query': '   ',
      'not a string': { find: 'orders' },
    },
  },
  async setup() {
    const db = await createMssqlTestDatabase();
    await db.sql(CONTRACT_FIXTURE_SQL);
    return {
      driver: createMssqlDriver(db.connection),
      unreachableDriver: createMssqlDriver({ ...db.connection, password: 'wrong-password' }),
      async countOrders() {
        const { recordset } = await db.sql('SELECT count(*) AS n FROM orders');
        return recordset[0]!.n as number;
      },
      teardown: () => db.drop(),
    };
  },
});

describe('mssql driver', () => {
  let db: MssqlTestDatabase;
  let driver: DataSourceDriver;

  beforeAll(async () => {
    db = await createMssqlTestDatabase();
    await db.sql(CONTRACT_FIXTURE_SQL);
    await db.sql(`
      CREATE TABLE [Big Deals] (
        id bigint, won bit, closed_on date, closed_at datetime2, closed_tz datetimeoffset, note nvarchar(20)
      );
      INSERT INTO [Big Deals] VALUES
        (9007199254740993, 1, '2026-01-05', '2026-01-05 10:00:00', '2026-01-05 10:00:00 +00:00', N'big');
    `);
    await db.sql(`CREATE VIEW north_orders AS SELECT id, amount FROM orders WHERE region = 'north'`);
    driver = createMssqlDriver(await db.createReadOnlyUser());
  });
  afterAll(async () => {
    await driver.close();
    await db.drop();
  });

  test('introspection includes views, with bracket-quoted ids where needed', async () => {
    const datasets = await driver.introspect();

    expect(datasets.find((d) => d.name === 'north_orders')).toMatchObject({
      id: 'dbo.north_orders',
      schema: 'dbo',
      kind: 'view',
      columns: [
        { name: 'id', type: 'integer', nativeType: 'int' },
        { name: 'amount', type: 'number', nativeType: 'decimal(10,2)' },
      ],
    });
    expect(datasets.find((d) => d.name === 'Big Deals')).toMatchObject({
      id: 'dbo.[Big Deals]',
      kind: 'table',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'won', type: 'boolean' },
        { name: 'closed_on', type: 'date' },
        { name: 'closed_at', type: 'datetime' },
        { name: 'closed_tz', type: 'datetime' },
        { name: 'note', type: 'string', nativeType: 'nvarchar(20)', nullable: true },
      ],
    });
    expect(datasets.find((d) => d.name === 'orders')?.columns[0]).toMatchObject({ nullable: false });
  });

  test('result values are JSON-friendly; big integers stay strings and zone-less dates stay text', async () => {
    const result = await driver.execute('SELECT * FROM [Big Deals]');

    expect(result.columns.map((c) => c.type)).toEqual(['integer', 'boolean', 'date', 'datetime', 'datetime', 'string']);
    expect(result.rows).toEqual([
      ['9007199254740993', true, '2026-01-05', '2026-01-05 10:00:00', new Date('2026-01-05T10:00:00Z'), 'big'],
    ]);
  });

  test('TOP, WITH, trailing semicolons and keywords inside strings are allowed', async () => {
    const result = await driver.execute(`
      -- totals per region; 'delete' here is only a comment
      WITH totals AS (SELECT region, sum(amount) AS total FROM orders GROUP BY region)
      SELECT TOP 10 region, total, 'drop table; update' AS label FROM totals ORDER BY region;
    `);

    expect(result.rows).toEqual([
      ['north', 17.75, 'drop table; update'],
      ['south', 20, 'drop table; update'],
    ]);
  });

  test('only the first result set comes back', async () => {
    const result = await driver.execute('SELECT 1 AS a SELECT 2 AS b');
    expect(result).toMatchObject({ columns: [{ name: 'a' }], rows: [[1]] });
  });

  test('engine errors come back readable, for the model to correct', async () => {
    await expect(driver.execute('SELECT nope FROM orders')).rejects.toThrow(QueryFailedError);
    await expect(driver.execute('SELECT nope FROM orders')).rejects.toThrow(/Invalid column name 'nope'/);
  });

  test('explains why an unquoted keyword column name was refused', async () => {
    await expect(driver.execute('SELECT [delete] FROM orders')).rejects.toThrow(QueryFailedError);
    await expect(driver.execute('SELECT delete FROM orders')).rejects.toThrow(QueryRejectedError);
  });

  test('stays usable after capped results', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(driver.execute(COUNT_TO(100000), { maxRows: 3 })).resolves.toMatchObject({
        rows: [[1], [2], [3]],
        truncated: true,
      });
    }
    await expect(driver.execute('SELECT count(*) FROM orders')).resolves.toMatchObject({ rows: [[3]] });
  });

  test('test connection names a missing database', async () => {
    const missing = createMssqlDriver({ ...db.connection, database: 'no_such_db' });
    try {
      expect(await missing.testConnection()).toEqual({ ok: false, error: expect.stringMatching(/no_such_db/) });
    } finally {
      await missing.close();
    }
  });

  test('test connection reports an unreachable host', async () => {
    const closed = createMssqlDriver({ ...db.connection, host: '127.0.0.1', port: 1 });
    try {
      expect(await closed.testConnection()).toEqual({ ok: false, error: expect.stringMatching(/127\.0\.0\.1:1/) });
    } finally {
      await closed.close();
    }
  });
});
