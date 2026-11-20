import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { QueryFailedError, QueryRejectedError, type DataSourceDriver } from '@/core/data-sources/driver';
import { describeDriverContract } from '../contract/driver-contract';
import { createPostgresDriver } from './postgres';
import { CONTRACT_FIXTURE_SQL, createPostgresTestDatabase, type PostgresTestDatabase } from './testing';

describeDriverContract({
  kind: 'postgres',
  queries: {
    ordersById: 'SELECT id, region, amount FROM orders ORDER BY id',
    twentyFiveRows: 'SELECT n FROM generate_series(1, 25) AS n',
    slow: 'SELECT pg_sleep(5)',
    forbidden: {
      INSERT: "INSERT INTO orders VALUES (4, 'east', 1)",
      UPDATE: 'UPDATE orders SET amount = 0',
      DELETE: 'DELETE FROM orders',
      'DROP TABLE': 'DROP TABLE orders',
      'CREATE TABLE': 'CREATE TABLE evil (id int)',
      TRUNCATE: 'TRUNCATE orders',
      'multiple statements': 'SELECT 1; DELETE FROM orders',
      'multiple statements hidden after a comment': 'SELECT 1 /* ; */; DELETE FROM orders --',
      'SELECT INTO': 'SELECT * INTO evil FROM orders',
      'data-modifying CTE': 'WITH gone AS (DELETE FROM orders RETURNING *) SELECT * FROM gone',
      'SELECT FOR UPDATE': 'SELECT * FROM orders FOR UPDATE',
      COPY: "COPY orders TO '/tmp/orders.csv'",
      'empty query': '   ',
      'not a string': { find: 'orders' },
    },
  },
  async setup() {
    const db = await createPostgresTestDatabase();
    await db.sql(CONTRACT_FIXTURE_SQL);
    return {
      driver: createPostgresDriver(db.connection),
      unreachableDriver: createPostgresDriver({ ...db.connection, password: 'wrong-password' }),
      async countOrders() {
        const { rows } = await db.sql('SELECT count(*)::int AS n FROM orders');
        return rows[0].n as number;
      },
      teardown: () => db.drop(),
    };
  },
});

describe('postgres driver', () => {
  let db: PostgresTestDatabase;
  let driver: DataSourceDriver;

  beforeAll(async () => {
    db = await createPostgresTestDatabase();
    await db.sql(`
      ${CONTRACT_FIXTURE_SQL}
      CREATE SEQUENCE ticket_seq;
      CREATE SCHEMA sales;
      CREATE TABLE sales."Big Deals" (
        id bigint, won boolean, closed_on date, closed_at timestamptz, meta jsonb, note varchar(20)
      );
      INSERT INTO sales."Big Deals" VALUES
        (9007199254740993, true, '2026-01-05', '2026-01-05T10:00:00Z', '{"a": 1}', 'big');
      CREATE VIEW north_orders AS SELECT id, amount FROM orders WHERE region = 'north';
    `);
    driver = createPostgresDriver(db.connection);
  });
  afterAll(async () => {
    await driver.close();
    await db.drop();
  });

  test('introspection includes views and other schemas, with quoted ids where needed', async () => {
    const datasets = await driver.introspect();

    expect(datasets.find((d) => d.name === 'north_orders')).toMatchObject({
      id: 'public.north_orders',
      schema: 'public',
      kind: 'view',
      columns: [
        { name: 'id', type: 'integer', nativeType: 'integer' },
        { name: 'amount', type: 'number', nativeType: 'numeric(10,2)' },
      ],
    });
    expect(datasets.find((d) => d.name === 'Big Deals')).toMatchObject({
      id: 'sales."Big Deals"',
      kind: 'table',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'won', type: 'boolean' },
        { name: 'closed_on', type: 'date' },
        { name: 'closed_at', type: 'datetime' },
        { name: 'meta', type: 'json' },
        { name: 'note', type: 'string', nativeType: 'character varying(20)', nullable: true },
      ],
    });
    expect(datasets.find((d) => d.name === 'orders')?.columns[0]).toMatchObject({ nullable: false });
    expect(datasets.some((d) => d.schema === 'pg_catalog' || d.schema === 'information_schema')).toBe(false);
  });

  test('result values are JSON-friendly; integers too big for JS stay strings', async () => {
    const result = await driver.execute('SELECT * FROM sales."Big Deals"');

    expect(result.columns.map((c) => c.type)).toEqual(['integer', 'boolean', 'date', 'datetime', 'json', 'string']);
    expect(result.rows).toEqual([
      ['9007199254740993', true, '2026-01-05', new Date('2026-01-05T10:00:00Z'), { a: 1 }, 'big'],
    ]);
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

  test('runs in a read-only transaction, so side-effecting functions fail too', async () => {
    await expect(driver.execute("SELECT nextval('ticket_seq')")).rejects.toThrow(/read-only transaction/);
    await expect(driver.execute("SELECT nextval('ticket_seq')")).rejects.toThrow(QueryFailedError);
  });

  test('engine errors come back readable, for the model to correct', async () => {
    await expect(driver.execute('SELECT nope FROM orders')).rejects.toThrow(/column "nope" does not exist/);
  });

  test('explains why an unquoted keyword column name was refused', async () => {
    await expect(driver.execute('SELECT update FROM orders')).rejects.toThrow(QueryRejectedError);
    await expect(driver.execute('SELECT update FROM orders')).rejects.toThrow(/UPDATE/);
  });

  test('test connection names a missing database', async () => {
    const missing = createPostgresDriver({ ...db.connection, database: 'no_such_db' });
    try {
      expect(await missing.testConnection()).toEqual({ ok: false, error: expect.stringMatching(/no_such_db/) });
    } finally {
      await missing.close();
    }
  });

  test('test connection reports an unreachable host', async () => {
    const closed = createPostgresDriver({ ...db.connection, host: '127.0.0.1', port: 1 });
    try {
      expect(await closed.testConnection()).toEqual({ ok: false, error: expect.stringMatching(/127\.0\.0\.1:1/) });
    } finally {
      await closed.close();
    }
  });
});
