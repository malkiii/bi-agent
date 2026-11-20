import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { QueryFailedError, QueryRejectedError, type DataSourceDriver } from '@/core/data-sources/driver';
import { describeDriverContract } from '../contract/driver-contract';
import { createMysqlDriver } from './mysql';
import { startTestServers } from '../sql/test-server';
import { CONTRACT_FIXTURE_SQL, createMysqlTestDatabase, type MysqlTestDatabase } from './testing';

startTestServers('mysql', 'mariadb');

for (const server of ['mysql', 'mariadb'] as const) {
  describeDriverContract({
    kind: server,
    queries: {
      ordersById: 'SELECT id, region, amount FROM orders ORDER BY id',
      twentyFiveRows:
        'WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 25) SELECT i FROM n',
      slow: 'SELECT SLEEP(5)',
      forbidden: {
        INSERT: "INSERT INTO orders VALUES (4, 'east', 1)",
        UPDATE: 'UPDATE orders SET amount = 0',
        DELETE: 'DELETE FROM orders',
        'DROP TABLE': 'DROP TABLE orders',
        'CREATE TABLE': 'CREATE TABLE evil (id int)',
        TRUNCATE: 'TRUNCATE orders',
        REPLACE: "REPLACE INTO orders VALUES (1, 'east', 1)",
        'multiple statements': 'SELECT 1; DELETE FROM orders',
        'multiple statements hidden after a # comment': 'SELECT 1 # ;\n; DELETE FROM orders',
        'SELECT INTO OUTFILE': "SELECT * FROM orders INTO OUTFILE '/tmp/orders.csv'",
        'SELECT INTO a variable': 'SELECT id INTO @x FROM orders LIMIT 1',
        LOAD_FILE: "SELECT LOAD_FILE('/etc/passwd')",
        'SELECT FOR UPDATE': 'SELECT * FROM orders FOR UPDATE',
        'LOCK IN SHARE MODE': 'SELECT * FROM orders LOCK IN SHARE MODE',
        'executable comment': 'SELECT * FROM orders /*!80000 FOR UPDATE */',
        "'--' without a space is not a comment": "SELECT 1 --1 INTO OUTFILE '/tmp/x'",
        'empty query': '   ',
        'not a string': { find: 'orders' },
      },
    },
    async setup() {
      const db = await createMysqlTestDatabase(server);
      await db.sql(CONTRACT_FIXTURE_SQL);
      return {
        driver: createMysqlDriver(db.connection),
        unreachableDriver: createMysqlDriver({ ...db.connection, password: 'wrong-password' }),
        async countOrders() {
          const rows = await db.sql('SELECT count(*) AS n FROM orders');
          return Number(rows[0]!.n);
        },
        teardown: () => db.drop(),
      };
    },
  });
}

describe('mysql driver', () => {
  let db: MysqlTestDatabase;
  let driver: DataSourceDriver;

  beforeAll(async () => {
    db = await createMysqlTestDatabase();
    await db.sql(`
      ${CONTRACT_FIXTURE_SQL}
      CREATE TABLE \`Big Deals\` (
        id bigint, won tinyint(1), closed_on date, closed_at datetime, meta json, note varchar(20)
      );
      INSERT INTO \`Big Deals\` VALUES
        (9007199254740993, 1, '2026-01-05', '2026-01-05 10:00:00', '{"a": 1}', 'big');
      CREATE VIEW north_orders AS SELECT id, amount FROM orders WHERE region = 'north';
    `);
    driver = createMysqlDriver(await db.createReadOnlyUser());
  });
  afterAll(async () => {
    await driver.close();
    await db.drop();
  });

  test('introspection includes views, with backtick-quoted ids where needed', async () => {
    const datasets = await driver.introspect();

    expect(datasets.find((d) => d.name === 'north_orders')).toMatchObject({
      id: 'north_orders',
      schema: db.connection.database,
      kind: 'view',
      columns: [
        { name: 'id', type: 'integer', nativeType: 'int' },
        { name: 'amount', type: 'number', nativeType: 'decimal(10,2)' },
      ],
    });
    expect(datasets.find((d) => d.name === 'Big Deals')).toMatchObject({
      id: '`Big Deals`',
      kind: 'table',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'won', type: 'integer' },
        { name: 'closed_on', type: 'date' },
        { name: 'closed_at', type: 'datetime' },
        { name: 'meta', type: 'json' },
        { name: 'note', type: 'string', nativeType: 'varchar(20)', nullable: true },
      ],
    });
    expect(datasets.find((d) => d.name === 'orders')?.columns[0]).toMatchObject({ nullable: false });
  });

  test('result values are JSON-friendly; big integers stay strings and dates stay text', async () => {
    const result = await driver.execute('SELECT * FROM `Big Deals`');

    expect(result.columns.map((c) => c.type)).toEqual(['integer', 'integer', 'date', 'datetime', 'json', 'string']);
    expect(result.rows).toEqual([['9007199254740993', 1, '2026-01-05', '2026-01-05 10:00:00', { a: 1 }, 'big']]);
  });

  test('WITH queries, trailing semicolons and keywords inside strings are allowed', async () => {
    const result = await driver.execute(`
      -- totals per region; 'delete' here is only a comment
      WITH totals AS (SELECT region, sum(amount) AS total FROM orders GROUP BY region)
      SELECT region, total, 'drop table; update' AS label FROM totals ORDER BY region;
    `);

    expect(result.rows).toEqual([
      ['north', 17.75, 'drop table; update'],
      ['south', 20, 'drop table; update'],
    ]);
  });

  test('runs in a read-only transaction, so a writing function the guard cannot see still fails', async () => {
    await db.sql(`
      CREATE TABLE audit (id int);
      CREATE FUNCTION sneaky() RETURNS int MODIFIES SQL DATA DETERMINISTIC
      BEGIN INSERT INTO audit VALUES (1); RETURN 1; END;
    `);
    const asOwner = createMysqlDriver(db.connection);
    try {
      await expect(asOwner.execute('SELECT sneaky()')).rejects.toThrow(/READ ONLY transaction/);
      expect(await db.sql('SELECT count(*) AS n FROM audit')).toEqual([{ n: 0 }]);
    } finally {
      await asOwner.close();
    }
  });

  test('engine errors come back readable, for the model to correct', async () => {
    await expect(driver.execute('SELECT nope FROM orders')).rejects.toThrow(QueryFailedError);
    await expect(driver.execute('SELECT nope FROM orders')).rejects.toThrow(/Unknown column 'nope'/);
  });

  test('explains why an unquoted keyword column name was refused', async () => {
    await expect(driver.execute('SELECT update FROM orders')).rejects.toThrow(QueryRejectedError);
    await expect(driver.execute('SELECT `update` FROM orders')).rejects.toThrow(QueryFailedError);
  });

  test('stays usable after a capped result', async () => {
    const big = 'WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000) SELECT i FROM n';
    for (let i = 0; i < 5; i++) {
      await expect(driver.execute(big, { maxRows: 3 })).resolves.toMatchObject({ rows: [[1], [2], [3]], truncated: true });
    }
    await expect(driver.execute('SELECT count(*) FROM orders')).resolves.toMatchObject({ rows: [[3]] });
  });

  test('test connection names a missing database', async () => {
    const missing = createMysqlDriver({ ...db.connection, database: 'no_such_db' });
    try {
      expect(await missing.testConnection()).toEqual({ ok: false, error: expect.stringMatching(/no_such_db/) });
    } finally {
      await missing.close();
    }
  });

  test('test connection reports an unreachable host', async () => {
    const closed = createMysqlDriver({ ...db.connection, host: '127.0.0.1', port: 1 });
    try {
      expect(await closed.testConnection()).toEqual({ ok: false, error: expect.stringMatching(/127\.0\.0\.1:1/) });
    } finally {
      await closed.close();
    }
  });
});
