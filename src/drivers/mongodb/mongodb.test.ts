import { Decimal128, Long, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { QueryFailedError, type DataSourceDriver } from '@/core/data-sources/driver';
import { describeDriverContract } from '../contract/driver-contract';
import { createMongoDriver, mongoKind } from './mongodb';
import { CONTRACT_FIXTURE_ORDERS, createMongoTestDatabase, type MongoTestDatabase } from './testing';

/** Two 20 000-element unwinds: 400 M documents, far more than 5 s of work. */
const slowPipeline = [
  { $limit: 1 },
  { $project: { a: { $range: [0, 20_000] } } },
  { $unwind: '$a' },
  { $project: { b: { $range: [0, 20_000] } } },
  { $unwind: '$b' },
  { $group: { _id: null, n: { $sum: 1 } } },
];

describeDriverContract({
  kind: 'mongodb',
  implicitColumns: ['_id'],
  queries: {
    ordersById: { find: 'orders', projection: { _id: 0, id: 1, region: 1, amount: 1 }, sort: { id: 1 } },
    twentyFiveRows: {
      aggregate: 'orders',
      pipeline: [{ $limit: 1 }, { $project: { _id: 0, n: { $range: [1, 26] } } }, { $unwind: '$n' }],
    },
    slow: { aggregate: 'orders', pipeline: slowPipeline },
    forbidden: {
      '$out stage': { aggregate: 'orders', pipeline: [{ $out: 'evil' }] },
      '$merge stage': { aggregate: 'orders', pipeline: [{ $merge: { into: 'orders' } }] },
      '$out inside $facet': { aggregate: 'orders', pipeline: [{ $facet: { a: [{ $out: 'evil' }] } }] },
      '$out inside a $lookup pipeline': {
        aggregate: 'orders',
        pipeline: [{ $lookup: { from: 'orders', as: 'x', pipeline: [{ $merge: { into: 'evil' } }] } }],
      },
      '$where filter': { find: 'orders', filter: { $where: 'true' } },
      '$where nested in $or': { find: 'orders', filter: { $or: [{ id: 1 }, { $where: 'true' }] } },
      '$function in a find filter': {
        find: 'orders',
        filter: { $expr: { $function: { body: 'function() { return true }', args: [], lang: 'js' } } },
      },
      '$function in a projection': {
        find: 'orders',
        projection: { x: { $function: { body: 'function() { return 1 }', args: [], lang: 'js' } } },
      },
      '$accumulator in $group': {
        aggregate: 'orders',
        pipeline: [
          {
            $group: {
              _id: null,
              x: {
                $accumulator: {
                  init: 'function() { return 0 }',
                  accumulate: 'function(s) { return s }',
                  accumulateArgs: [],
                  merge: 'function(a) { return a }',
                  lang: 'js',
                },
              },
            },
          },
        ],
      },
      'a write command': { delete: 'orders', deletes: [{ q: {}, limit: 0 }] },
      'find with an unknown option': { find: 'orders', update: { $set: { amount: 0 } } },
      'both find and aggregate': { find: 'orders', aggregate: 'orders', pipeline: [] },
      'pipeline that is not an array': { aggregate: 'orders', pipeline: { $match: {} } },
      'collection that is not a name': { find: { $ne: null } },
      'a string query': 'db.orders.find()',
    },
  },
  async setup() {
    const t = await createMongoTestDatabase();
    await t.db.collection('orders').insertMany(CONTRACT_FIXTURE_ORDERS.map((o) => ({ ...o })));
    return {
      driver: createMongoDriver(t.connection),
      unreachableDriver: createMongoDriver(
        { uri: 'mongodb://127.0.0.1:1/?directConnection=true', database: t.connection.database },
        { serverSelectionTimeoutMs: 2000 },
      ),
      countOrders: () => t.db.collection('orders').countDocuments(),
      teardown: () => t.drop(),
    };
  },
});

describe('mongodb driver', () => {
  let t: MongoTestDatabase;
  let driver: DataSourceDriver;
  const customerId = new ObjectId('65a000000000000000000001');

  beforeAll(async () => {
    t = await createMongoTestDatabase();
    await t.db.collection('orders').insertMany(CONTRACT_FIXTURE_ORDERS.map((o) => ({ ...o })));
    await t.db.collection('customers').insertMany([
      {
        _id: customerId,
        name: 'Ada',
        address: { city: 'Paris', geo: { lat: 48.8 } },
        tags: ['vip', 'beta'],
        since: new Date('2026-01-05T10:00:00Z'),
        balance: Decimal128.fromString('12.50'),
        visits: Long.fromString('9007199254740993'),
        active: true,
      },
      { _id: new ObjectId('65a000000000000000000002'), name: 'Bob', address: { city: 'Oslo' }, active: false },
    ]);
    await t.db.createCollection('north_orders', { viewOn: 'orders', pipeline: [{ $match: { region: 'north' } }] });
    driver = createMongoDriver(t.connection);
  });
  afterAll(async () => {
    await driver.close();
    await t.drop();
  });

  test('introspection infers flattened fields and types from a sample of each collection', async () => {
    const datasets = await driver.introspect();
    const customers = datasets.find((d) => d.name === 'customers');

    expect(customers).toMatchObject({ id: 'customers', schema: null, kind: 'collection' });
    expect(customers!.columns).toEqual([
      { name: '_id', type: 'string', nativeType: 'objectId', nullable: false },
      { name: 'name', type: 'string', nativeType: 'string', nullable: false },
      { name: 'address.city', type: 'string', nativeType: 'string', nullable: false },
      { name: 'address.geo.lat', type: 'number', nativeType: 'double', nullable: true },
      { name: 'tags', type: 'json', nativeType: 'array', nullable: true },
      { name: 'since', type: 'datetime', nativeType: 'date', nullable: true },
      { name: 'balance', type: 'number', nativeType: 'decimal', nullable: true },
      { name: 'visits', type: 'integer', nativeType: 'long', nullable: true },
      { name: 'active', type: 'boolean', nativeType: 'bool', nullable: false },
    ]);
    const amount = datasets.find((d) => d.name === 'orders')!.columns.find((c) => c.name === 'amount');
    expect(amount).toMatchObject({ type: 'number' });
    expect(amount!.nativeType.split('|').sort()).toEqual(['double', 'int']);
  });

  test('tells the agent to write the structured Mongo query format', () => {
    expect(driver.dialect).toMatchObject({ language: 'mongo', flavour: 'mongodb' });
    expect(driver.dialect.guidance).toMatch(/"find": "<collection>"/);
    expect(driver.dialect.guidance).toMatch(/"aggregate": "<collection>", "pipeline"/);
  });

  test('introspection lists views', async () => {
    const datasets = await driver.introspect();

    expect(datasets.find((d) => d.name === 'north_orders')).toMatchObject({ kind: 'view' });
  });

  test('results flatten subdocuments to dotted columns, with JSON-friendly values', async () => {
    const result = await driver.execute({ find: 'customers', sort: { name: 1 } });

    expect(result.columns).toEqual([
      { name: '_id', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'address.city', type: 'string' },
      { name: 'address.geo.lat', type: 'number' },
      { name: 'tags', type: 'json' },
      { name: 'since', type: 'datetime' },
      { name: 'balance', type: 'number' },
      { name: 'visits', type: 'integer' },
      { name: 'active', type: 'boolean' },
    ]);
    expect(result.rows).toEqual([
      [
        '65a000000000000000000001',
        'Ada',
        'Paris',
        48.8,
        ['vip', 'beta'],
        new Date('2026-01-05T10:00:00Z'),
        12.5,
        '9007199254740993',
        true,
      ],
      ['65a000000000000000000002', 'Bob', 'Oslo', null, null, null, null, null, false],
    ]);
  });

  test('aggregations work, and typed values can be written as Extended JSON', async () => {
    const result = await driver.execute({
      aggregate: 'customers',
      pipeline: [
        { $match: { since: { $gte: { $date: '2026-01-01T00:00:00Z' } }, _id: { $oid: customerId.toHexString() } } },
        { $project: { _id: 0, name: 1 } },
      ],
    });

    expect(result.rows).toEqual([['Ada']]);
  });

  test('find honours its own limit and skip', async () => {
    const result = await driver.execute({
      find: 'orders',
      projection: { _id: 0, id: 1 },
      sort: { id: 1 },
      skip: 1,
      limit: 1,
    });

    expect(result.rows).toEqual([[2]]);
    expect(result.truncated).toBe(false);
  });

  test('engine errors come back readable, for the model to correct', async () => {
    const bad = { aggregate: 'orders', pipeline: [{ $nope: {} }] };

    await expect(driver.execute(bad)).rejects.toThrow(QueryFailedError);
    await expect(driver.execute(bad)).rejects.toThrow(/\$nope/);
  });

  test('names the forbidden operator it refused', async () => {
    await expect(driver.execute({ find: 'orders', filter: { $where: 'true' } })).rejects.toThrow(/\$where/);
  });

  test('test connection reports an invalid connection string without throwing', async () => {
    const bad = createMongoDriver({ uri: 'not-a-uri', database: 'x' });
    try {
      expect(await bad.testConnection()).toEqual({ ok: false, error: expect.stringMatching(/connection string/i) });
    } finally {
      await bad.close();
    }
  });

  test('the kind validates its connection string', () => {
    expect(mongoKind.secretsSchema.safeParse({ connectionString: 'postgres://x' }).success).toBe(false);
    expect(mongoKind.secretsSchema.safeParse({ connectionString: 'mongodb+srv://u:p@h/db' }).success).toBe(true);
  });
});
