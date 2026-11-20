import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { QueryFailedError, QueryRejectedError } from '@/core/data-sources/driver';
import { describeDriverContract } from '../contract/driver-contract';
import { createSalesforceDriver, type SalesforceConnection } from './salesforce';
import {
  CONTRACT_FIXTURE_OBJECT,
  CONTRACT_FIXTURE_RECORDS,
  startFakeSalesforce,
  type FakeSalesforce,
} from './testing';

function connectionTo(fake: FakeSalesforce, tokens = fake.issueTokens()): SalesforceConnection {
  return {
    loginUrl: fake.url,
    clientId: fake.clientId,
    clientSecret: fake.clientSecret,
    apiVersion: fake.apiVersion,
    instanceUrl: fake.url,
    ...tokens,
  };
}

const TWENTY_FIVE = 'SELECT Id FROM Contact LIMIT 25';
const SLOW = 'SELECT Id FROM BigObject__b';

/**
 * The whole shared contract applies to Salesforce. SOQL has no writes, DDL or multiple
 * statements, so the forbidden queries are the ones the driver must refuse before any request:
 * DML-looking text, statement chaining, clauses with write side effects (FOR VIEW / FOR
 * REFERENCE / FOR UPDATE / UPDATE TRACKING / UPDATE VIEWSTAT) and structured queries.
 * `countOrders` reads the fake org's records, which nothing can change: the fake only answers
 * GET, and the kind-specific tests below also prove refused queries never reach it.
 */
describeDriverContract({
  kind: 'salesforce',
  queries: {
    ordersById: 'SELECT id, region, amount FROM orders ORDER BY id',
    twentyFiveRows: TWENTY_FIVE,
    slow: SLOW,
    forbidden: {
      DELETE: 'DELETE FROM orders',
      UPDATE: "UPDATE orders SET region = 'x'",
      'multiple statements': 'SELECT id FROM orders; SELECT id FROM orders',
      'FOR UPDATE (locks records)': 'SELECT id FROM orders FOR UPDATE',
      'FOR VIEW (writes LastViewedDate)': 'SELECT id FROM orders FOR VIEW',
      'FOR REFERENCE (writes LastReferencedDate)': 'SELECT id FROM orders FOR REFERENCE',
      'UPDATE TRACKING': 'SELECT id FROM orders UPDATE TRACKING',
      'UPDATE VIEWSTAT': 'SELECT id FROM orders UPDATE VIEWSTAT',
      'empty query': '   ',
      'not a string': { find: 'orders' },
    },
  },
  async setup() {
    const fake = await startFakeSalesforce();
    fake.objects.push(CONTRACT_FIXTURE_OBJECT);
    fake.pageSize = 10; // 25 rows arrive over three pages
    fake.soql('SELECT id, region, amount FROM orders ORDER BY id', CONTRACT_FIXTURE_RECORDS, { type: 'orders' });
    fake.soql(
      TWENTY_FIVE,
      Array.from({ length: 25 }, (_, i) => ({ Id: `003${String(i).padStart(15, '0')}` })),
      { type: 'Contact' },
    );
    fake.soql(SLOW, [{ Id: 'x' }], { delayMs: 5000 });
    const revoked = await startFakeSalesforce();
    revoked.revokeRefreshTokens();
    return {
      driver: createSalesforceDriver(connectionTo(fake)),
      unreachableDriver: createSalesforceDriver(connectionTo(revoked, { accessToken: 'stale', refreshToken: 'revoked' })),
      countOrders: async () => CONTRACT_FIXTURE_RECORDS.length,
      async teardown() {
        await fake.close();
        await revoked.close();
      },
    };
  },
});

describe('salesforce driver', () => {
  let fake: FakeSalesforce;
  beforeAll(async () => {
    fake = await startFakeSalesforce();
  });
  afterAll(() => fake.close());
  beforeEach(() => {
    fake.requests.length = 0;
    fake.objects.length = 0;
  });

  test('refused queries never reach Salesforce', async () => {
    const driver = createSalesforceDriver(connectionTo(fake));

    await expect(driver.execute('DELETE FROM Account')).rejects.toThrow(QueryRejectedError);
    await expect(driver.execute('SELECT Id FROM Account FOR VIEW')).rejects.toThrow(QueryRejectedError);

    expect(fake.requests).toEqual([]);
  });

  test('semicolons and keywords inside string literals are fine', async () => {
    const soql = "SELECT Id FROM Account WHERE Name = 'Drop; FOR UPDATE \\' co'";
    fake.soql(soql, [{ Id: '001A' }]);

    const result = await createSalesforceDriver(connectionTo(fake)).execute(soql);

    expect(result.rows).toEqual([['001A']]);
  });

  test('on 401 it refreshes the access token once, retries, and reports the new tokens', async () => {
    fake.soql('SELECT Id FROM Account', [{ Id: '001A' }]);
    const saved: unknown[] = [];
    const driver = createSalesforceDriver(connectionTo(fake), { onTokens: (t) => void saved.push(t) });
    fake.expireAccessTokens();

    await expect(driver.execute('SELECT Id FROM Account')).resolves.toMatchObject({ rows: [['001A']] });
    await expect(driver.execute('SELECT Id FROM Account')).resolves.toMatchObject({ rows: [['001A']] });

    expect(fake.requests.filter((r) => r.path === '/services/oauth2/token')).toHaveLength(1);
    expect(saved).toEqual([{ accessToken: expect.any(String), refreshToken: expect.any(String), instanceUrl: fake.url }]);
  });

  test('without an access token it refreshes before the first call', async () => {
    fake.soql('SELECT Id FROM Account', [{ Id: '001A' }]);
    const { refreshToken } = fake.issueTokens();
    const driver = createSalesforceDriver({
      ...connectionTo(fake),
      accessToken: undefined,
      instanceUrl: undefined,
      refreshToken,
    });

    await expect(driver.execute('SELECT Id FROM Account')).resolves.toMatchObject({ rows: [['001A']] });
  });

  test("Salesforce's query errors come back as QueryFailedError with its code and message", async () => {
    const run = createSalesforceDriver(connectionTo(fake)).execute('SELECT Nope FROM Account');

    await expect(run).rejects.toThrow(QueryFailedError);
    await expect(run).rejects.toThrow(/MALFORMED_QUERY: unexpected token/);
  });

  test('parent relationships become dot-path columns, child subqueries JSON, attributes are dropped', async () => {
    const soql = 'SELECT Name, Owner.Name, (SELECT LastName FROM Contacts) FROM Account';
    fake.soql(soql, [
      {
        Name: 'Acme',
        Owner: { attributes: { type: 'User' }, Name: 'Ada' },
        Contacts: { totalSize: 1, done: true, records: [{ attributes: { type: 'Contact' }, LastName: 'Lovelace' }] },
      },
      { Name: 'Globex', Owner: { attributes: { type: 'User' }, Name: 'Grace' }, Contacts: null },
    ]);

    const result = await createSalesforceDriver(connectionTo(fake)).execute(soql);

    expect(result.columns).toEqual([
      { name: 'Name', type: 'string' },
      { name: 'Owner.Name', type: 'string' },
      { name: 'Contacts', type: 'json' },
    ]);
    expect(result.rows).toEqual([
      ['Acme', 'Ada', [{ LastName: 'Lovelace' }]],
      ['Globex', 'Grace', null],
    ]);
  });

  test('dates, datetimes, booleans and aggregates get column types from their values', async () => {
    const soql =
      'SELECT CloseDate, CreatedDate, IsWon, SUM(Amount) total FROM Opportunity GROUP BY CloseDate, CreatedDate, IsWon';
    fake.soql(soql, [{ CloseDate: '2026-01-05', CreatedDate: '2026-01-05T10:00:00.000+0000', IsWon: true, total: 1500 }], {
      type: 'AggregateResult',
    });

    const result = await createSalesforceDriver(connectionTo(fake)).execute(soql);

    expect(result.columns.map((c) => c.type)).toEqual(['date', 'datetime', 'boolean', 'integer']);
  });

  test('an empty result still names its columns from the SELECT list', async () => {
    const soql = "SELECT Id, Account.Name, COUNT(Id) n, MAX(Amount) FROM Opportunity WHERE Name = 'x, y' GROUP BY Id";
    fake.soql(soql, []);

    const result = await createSalesforceDriver(connectionTo(fake)).execute(soql);

    expect(result.columns.map((c) => c.name)).toEqual(['Id', 'Account.Name', 'n', 'expr0']);
    expect(result.rows).toEqual([]);
  });

  test('SELECT COUNT() returns the total as one row', async () => {
    fake.soql('SELECT COUNT() FROM Account', []);

    const result = await createSalesforceDriver(connectionTo(fake)).execute('SELECT COUNT() FROM Account');

    expect(result).toMatchObject({ columns: [{ name: 'count', type: 'integer' }], rows: [[0]] });
  });

  test('introspection lists queryable objects with typed fields, skipping history/share/feed noise', async () => {
    fake.objects.push(
      {
        name: 'Account',
        fields: [
          { name: 'Id', type: 'id', nillable: false },
          { name: 'Name', type: 'string', length: 255, nillable: false },
          { name: 'OwnerId', type: 'reference', referenceTo: ['User'] },
          { name: 'AnnualRevenue', type: 'currency' },
          { name: 'NumberOfEmployees', type: 'int' },
          { name: 'IsDeleted', type: 'boolean' },
          { name: 'CreatedDate', type: 'datetime' },
          { name: 'BillingAddress', type: 'address' },
          { name: 'Photo', type: 'base64' },
        ],
      },
      { name: 'AccountHistory', fields: [] },
      { name: 'AccountShare', fields: [] },
      { name: 'AccountFeed', fields: [] },
      { name: 'AccountChangeEvent', fields: [] },
      { name: 'Invoice__c', fields: [{ name: 'Total__c', type: 'double' }] },
      { name: 'Hidden', queryable: false, fields: [] },
    );

    const datasets = await createSalesforceDriver(connectionTo(fake)).introspect();

    expect(datasets.map((d) => d.id)).toEqual(['Account', 'Invoice__c']);
    expect(datasets[0]).toMatchObject({ name: 'Account', schema: null, kind: 'object' });
    expect(datasets[0]!.columns).toEqual([
      { name: 'Id', type: 'string', nativeType: 'id', nullable: false },
      { name: 'Name', type: 'string', nativeType: 'string(255)', nullable: false },
      { name: 'OwnerId', type: 'string', nativeType: 'reference(User)', nullable: true },
      { name: 'AnnualRevenue', type: 'number', nativeType: 'currency', nullable: true },
      { name: 'NumberOfEmployees', type: 'integer', nativeType: 'int', nullable: true },
      { name: 'IsDeleted', type: 'boolean', nativeType: 'boolean', nullable: true },
      { name: 'CreatedDate', type: 'datetime', nativeType: 'datetime', nullable: true },
      { name: 'BillingAddress', type: 'json', nativeType: 'address', nullable: true },
      { name: 'Photo', type: 'other', nativeType: 'base64', nullable: true },
    ]);
    expect(fake.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  test('a Data Source that was never connected says how to connect', async () => {
    const driver = createSalesforceDriver({ ...connectionTo(fake), accessToken: undefined, refreshToken: undefined });

    expect(await driver.testConnection()).toEqual({ ok: false, error: expect.stringMatching(/Connect to Salesforce/) });
  });
});
