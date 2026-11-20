/**
 * The shared Data Source driver contract suite. Every driver kind runs it from its own
 * test file (see src/drivers/postgres/postgres.test.ts):
 *
 *   describeDriverContract({ kind: 'postgres', queries, setup: async () => ({ driver, ... }) });
 *
 * `setup` must seed the source with the contract fixture: one Dataset named `orders`
 * with columns `id` (integer), `region` (string), `amount` (number, non-integer) holding
 *
 *   (1, 'north', 10.5), (2, 'south', 20), (3, 'north', 7.25)
 *
 * and `queries` are written in the driver's own language.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  QueryRejectedError,
  QueryTimeoutError,
  type DataSourceDriver,
  type DriverQuery,
} from '@/core/data-sources/driver';

export interface DriverContractQueries {
  /** Every `orders` row, ordered by id, selecting `id, region, amount`. */
  ordersById: DriverQuery;
  /** Exactly 25 rows (from any source, e.g. a generated series). */
  twentyFiveRows: DriverQuery;
  /** Takes at least 5 seconds to finish (e.g. a sleep). */
  slow: DriverQuery;
  /**
   * Queries that must be refused with QueryRejectedError without touching data, keyed by
   * test title. Include writes, DDL and multiple statements (SQL) or `$out`/`$merge`/JS
   * stages (Mongo).
   */
  forbidden: Readonly<Record<string, DriverQuery>>;
}

export interface DriverContractFixture {
  /** Connected to a source seeded with the contract fixture. */
  driver: DataSourceDriver;
  /** Same kind, pointed at something that refuses the connection (wrong port or credentials). */
  unreachableDriver: DataSourceDriver;
  /** Counts `orders` rows without going through the driver, to prove nothing was written. */
  countOrders(): Promise<number>;
  teardown(): Promise<void>;
}

export interface DriverContractOptions {
  kind: string;
  queries: DriverContractQueries;
  setup(): Promise<DriverContractFixture>;
}

export function describeDriverContract({ kind, queries, setup }: DriverContractOptions) {
  describe(`${kind} driver contract`, () => {
    let f: DriverContractFixture;

    beforeAll(async () => {
      f = await setup();
    });
    afterAll(async () => {
      await f?.driver.close();
      await f?.unreachableDriver.close();
      await f?.teardown();
    });

    test('describes its query dialect', () => {
      expect(f.driver.dialect.language).toMatch(/^(sql|mongo|soql)$/);
      expect(f.driver.dialect.flavour).not.toBe('');
      expect(f.driver.dialect.guidance).not.toBe('');
    });

    test('test connection succeeds against a reachable source', async () => {
      expect(await f.driver.testConnection()).toEqual({ ok: true });
    });

    test('test connection reports a readable error when the source refuses', async () => {
      const result = await f.unreachableDriver.testConnection();

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toMatch(/\w{3,}/);
    });

    test('introspection lists the fixture Dataset with its columns and types', async () => {
      const datasets = await f.driver.introspect();
      const orders = datasets.find((d) => d.name === 'orders');

      expect(orders).toBeDefined();
      expect(orders!.id).not.toBe('');
      expect(orders!.columns.map(({ name, type }) => ({ name, type }))).toEqual([
        { name: 'id', type: 'integer' },
        { name: 'region', type: 'string' },
        { name: 'amount', type: 'number' },
      ]);
      expect(orders!.columns.every((c) => c.nativeType !== '')).toBe(true);
    });

    test('executes a read query, returning columns and rows', async () => {
      const result = await f.driver.execute(queries.ordersById);

      expect(result.columns.map((c) => c.name)).toEqual(['id', 'region', 'amount']);
      expect(result.rows).toEqual([
        [1, 'north', 10.5],
        [2, 'south', 20],
        [3, 'north', 7.25],
      ]);
      expect(result.truncated).toBe(false);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    test('caps rows at maxRows and flags the result as truncated', async () => {
      const result = await f.driver.execute(queries.twentyFiveRows, { maxRows: 10 });

      expect(result.rows).toHaveLength(10);
      expect(result.truncated).toBe(true);
    });

    test('a result that exactly fits maxRows is not truncated', async () => {
      const result = await f.driver.execute(queries.twentyFiveRows, { maxRows: 25 });

      expect(result.rows).toHaveLength(25);
      expect(result.truncated).toBe(false);
    });

    test('cancels a query that runs past the timeout, and stays usable', async () => {
      const started = Date.now();

      await expect(f.driver.execute(queries.slow, { timeoutMs: 1000 })).rejects.toThrow(QueryTimeoutError);
      expect(Date.now() - started).toBeLessThan(4500);
      await expect(f.driver.execute(queries.ordersById)).resolves.toMatchObject({ truncated: false });
    });

    describe('refuses anything but a single read-only query, leaving data unchanged', () => {
      test.each(Object.entries(queries.forbidden))('%s', async (_name, query) => {
        const before = await f.countOrders();

        await expect(f.driver.execute(query)).rejects.toThrow(QueryRejectedError);
        expect(await f.countOrders()).toBe(before);
      });
    });
  });
}
