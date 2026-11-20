import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { ForbiddenError, ValidationError } from '@/core';
import { createTestHarness, type TestHarness } from '@/core/testing';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '@/drivers/postgres/testing';

const ADMIN = 'UADMIN';
const MEMBER = 'UMEMBER';

let pgDb: PostgresTestDatabase;
beforeAll(async () => {
  pgDb = await createPostgresTestDatabase();
  await pgDb.sql(`
    CREATE TABLE orders (id integer, region text, total_amount numeric(10, 2), status text);
    INSERT INTO orders VALUES (1, 'north', 10.5, 'shipped'), (2, 'south', 20, 'open');
  `);
});
afterAll(() => pgDb.drop());

let h: TestHarness;
let warehouseId: string;
beforeEach(async () => {
  h = await createTestHarness({ config: { slackTeamId: 'T1', adminSlackUserIds: [ADMIN] } });
  for (const slackUserId of [ADMIN, MEMBER]) {
    await h.core.users.signIn({ slackUserId, slackTeamId: 'T1', name: slackUserId, email: null, image: null });
  }
  const { host, port, database, user, password } = pgDb.connection;
  const ds = await h.core.dataSources.create(ADMIN, {
    name: 'Warehouse',
    kind: 'postgres',
    config: { host, port, database, user, sslMode: 'disable' },
    secrets: { password },
  });
  await h.core.dataSources.refreshSchema(ADMIN, ds.id);
  await h.core.dataSources.setExposedDatasets(ADMIN, ds.id, ['public.orders']);
  warehouseId = ds.id;
});
afterEach(() => h.close());

const ORDERS_DETAILS = {
  description: 'One row per customer order.',
  synonyms: ['sales', ' purchases ', 'Sales', ''],
  columns: {
    total_amount: { description: 'Order value in EUR, VAT included.', synonyms: ['revenue', 'turnover'] },
    status: { description: 'open, shipped or cancelled', synonyms: [] },
  },
};

async function orders() {
  return (await h.core.dataSources.get(warehouseId)).datasets.find((d) => d.id === 'public.orders')!;
}

describe('describing Datasets and columns', () => {
  test('an admin adds descriptions and Synonyms to a Dataset and its columns', async () => {
    await h.core.dataSources.updateDatasetDetails(ADMIN, warehouseId, 'public.orders', ORDERS_DETAILS);

    const dataset = await orders();
    expect(dataset).toMatchObject({ description: 'One row per customer order.', synonyms: ['sales', 'purchases'] });
    expect(dataset.columns.find((c) => c.name === 'total_amount')).toMatchObject({
      description: 'Order value in EUR, VAT included.',
      synonyms: ['revenue', 'turnover'],
    });
    expect(dataset.columns.find((c) => c.name === 'status')).toMatchObject({ description: 'open, shipped or cancelled' });
    expect(dataset.columns.find((c) => c.name === 'id')).not.toHaveProperty('description');
  });

  test('clearing a description or Synonym removes it', async () => {
    await h.core.dataSources.updateDatasetDetails(ADMIN, warehouseId, 'public.orders', ORDERS_DETAILS);

    await h.core.dataSources.updateDatasetDetails(ADMIN, warehouseId, 'public.orders', {
      description: '  ',
      synonyms: [],
      columns: { total_amount: { description: '', synonyms: ['revenue'] } },
    });

    const dataset = await orders();
    expect(dataset).not.toHaveProperty('description');
    expect(dataset).not.toHaveProperty('synonyms');
    expect(dataset.columns.find((c) => c.name === 'total_amount')).toEqual(
      expect.not.objectContaining({ description: expect.anything() }),
    );
    expect(dataset.columns.find((c) => c.name === 'total_amount')).toMatchObject({ synonyms: ['revenue'] });
    expect(dataset.columns.find((c) => c.name === 'status')).not.toHaveProperty('description');
  });

  test('members cannot edit descriptions or Synonyms', async () => {
    await expect(
      h.core.dataSources.updateDatasetDetails(MEMBER, warehouseId, 'public.orders', ORDERS_DETAILS),
    ).rejects.toThrow(ForbiddenError);
    expect(await orders()).not.toHaveProperty('description');
  });

  test('unknown Datasets and columns are refused', async () => {
    await expect(
      h.core.dataSources.updateDatasetDetails(ADMIN, warehouseId, 'public.nope', ORDERS_DETAILS),
    ).rejects.toThrow(ValidationError);
    await expect(
      h.core.dataSources.updateDatasetDetails(ADMIN, warehouseId, 'public.orders', {
        columns: { nope: { description: 'x', synonyms: [] } },
      }),
    ).rejects.toThrow(/nope/);
  });
});

describe('refreshing the schema', () => {
  test('keeps descriptions and Synonyms of unchanged columns and of the Dataset', async () => {
    const db = await createPostgresTestDatabase();
    try {
      await db.sql('CREATE TABLE orders (id integer, total_amount numeric(10, 2), status text, region text);');
      const { host, port, database, user, password } = db.connection;
      const ds = await h.core.dataSources.create(ADMIN, {
        name: 'Changing',
        kind: 'postgres',
        config: { host, port, database, user, sslMode: 'disable' },
        secrets: { password },
      });
      await h.core.dataSources.refreshSchema(ADMIN, ds.id);
      await h.core.dataSources.updateDatasetDetails(ADMIN, ds.id, 'public.orders', {
        ...ORDERS_DETAILS,
        columns: { ...ORDERS_DETAILS.columns, region: { description: 'Sales region', synonyms: ['area'] } },
      });

      // total_amount unchanged, status changes type, region is dropped, channel is new.
      await db.sql('ALTER TABLE orders ALTER COLUMN status TYPE integer USING 0; ALTER TABLE orders DROP COLUMN region;');
      await db.sql('ALTER TABLE orders ADD COLUMN channel text;');
      const refreshed = await h.core.dataSources.refreshSchema(ADMIN, ds.id);

      const dataset = refreshed.datasets.find((d) => d.id === 'public.orders')!;
      expect(dataset).toMatchObject({ description: 'One row per customer order.', synonyms: ['sales', 'purchases'] });
      expect(dataset.columns.map((c) => c.name)).toEqual(['id', 'total_amount', 'status', 'channel']);
      expect(dataset.columns[1]).toMatchObject({ description: 'Order value in EUR, VAT included.', synonyms: ['revenue', 'turnover'] });
      expect(dataset.columns[2]).toEqual({ name: 'status', type: 'integer', nativeType: 'integer', nullable: true });
      expect(dataset.columns[3]).toEqual({ name: 'channel', type: 'string', nativeType: 'text', nullable: true });
    } finally {
      await db.drop();
    }
  });
});

describe('the agent sees descriptions and Synonyms', () => {
  test('listDatasets and describeDataset include them, so business terms resolve', async () => {
    await h.core.dataSources.updateDatasetDetails(ADMIN, warehouseId, 'public.orders', ORDERS_DETAILS);
    h.llm.script(
      { toolCalls: [{ toolName: 'listDatasets', input: {} }] },
      { toolCalls: [{ toolName: 'describeDataset', input: { dataSourceId: warehouseId, datasetId: 'public.orders' } }] },
      { text: '' },
    );

    const conversation = await h.core.conversations.startWeb(MEMBER);
    await h.core.conversations.ask(MEMBER, conversation.id, 'What was our revenue?');

    const [listed, described] = [1, 2].map((call) => toolResult(h.llm.model.doStreamCalls[call]?.prompt));
    expect(listed).toEqual([
      expect.objectContaining({
        datasets: [
          expect.objectContaining({
            id: 'public.orders',
            description: 'One row per customer order.',
            synonyms: ['sales', 'purchases'],
            columnSynonyms: { total_amount: ['revenue', 'turnover'] },
          }),
        ],
      }),
    ]);
    expect(described).toMatchObject({
      description: 'One row per customer order.',
      synonyms: ['sales', 'purchases'],
      columns: expect.arrayContaining([
        expect.objectContaining({
          name: 'total_amount',
          description: 'Order value in EUR, VAT included.',
          synonyms: ['revenue', 'turnover'],
        }),
      ]),
    });
  });
});

/** The output of the last tool call in a model prompt. */
function toolResult(prompt: unknown): unknown {
  const messages = prompt as { role: string; content: { type: string; output?: { type: string; value: unknown } }[] }[];
  const last = messages.filter((m) => m.role === 'tool').at(-1);
  const part = last?.content.find((c) => c.type === 'tool-result');
  return part?.output?.value;
}
