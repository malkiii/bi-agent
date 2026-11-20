import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestHarness, type TestHarness } from '@/core/testing';
import { ValidationError, type Answer } from '@/core';
import { CONTRACT_FIXTURE_SQL, createPostgresTestDatabase, type PostgresTestDatabase } from '@/drivers/postgres/testing';

const ADMIN = 'UADMIN';
const MEMBER = 'UMEMBER';

const TOTALS_SQL = 'SELECT region, sum(amount) AS total, count(*) AS orders FROM orders GROUP BY region ORDER BY region';

let pgDb: PostgresTestDatabase;
let h: TestHarness;
let warehouseId: string;
beforeEach(async () => {
  pgDb = await createPostgresTestDatabase();
  await pgDb.sql(CONTRACT_FIXTURE_SQL);
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
afterEach(async () => {
  await h.close();
  await pgDb.drop();
});

/** Asks one Prompt with a scripted model: runs `TOTALS_SQL` as `totals`, then emits text + a table. */
async function answerTotals(table: Record<string, unknown> = { resultId: 'totals', title: 'Totals' }): Promise<Answer> {
  h.llm.script(
    { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query: TOTALS_SQL, name: 'totals' } }] },
    {
      toolCalls: [
        { toolName: 'emitText', input: { markdown: 'Sales by region:' } },
        { toolName: 'emitTable', input: table },
      ],
    },
    { text: '' },
  );
  const conversation = await h.core.conversations.startWeb(MEMBER);
  return h.core.conversations.ask(MEMBER, conversation.id, 'Sales by region?');
}

describe('Pinned Queries', () => {
  test('re-running an Answer’s Pinned Queries gives fresh results in the same layout, without the LLM', async () => {
    const answer = await answerTotals();
    const pinned = h.core.pinnedQueries.pin(answer);
    await pgDb.sql("INSERT INTO orders VALUES (4, 'south', 5)");
    const llmCalls = h.llm.model.doStreamCalls.length;

    const run = await h.core.pinnedQueries.run(pinned);

    expect(h.llm.model.doStreamCalls).toHaveLength(llmCalls);
    expect(run.status).toBe('complete');
    expect(run.blocks).toEqual([
      { status: 'ok', block: { type: 'text', markdown: 'Sales by region:' } },
      {
        status: 'ok',
        block: {
          type: 'table',
          title: 'Totals',
          resultId: 'totals',
          columns: [
            { name: 'region', type: 'string' },
            { name: 'total', type: 'number' },
            { name: 'orders', type: 'integer' },
          ],
          rows: [
            ['north', 17.75, 2],
            ['south', 25, 2],
          ],
          truncated: false,
        },
      },
    ]);
    expect(run.queries).toMatchObject([{ resultId: 'totals', dataSourceId: warehouseId, query: TOTALS_SQL, ok: true, rowCount: 2 }]);
    expect(run.sources).toEqual([{ dataSourceId: warehouseId, name: 'Warehouse', datasets: ['public.orders'] }]);
  });

  test('a chart is pinned with its spec and redrawn from fresh rows', async () => {
    const spec = { mark: 'bar', encoding: { x: { field: 'region', type: 'nominal' }, y: { field: 'total', type: 'quantitative' } } };
    h.llm.script(
      { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query: TOTALS_SQL, name: 'totals' } }] },
      { toolCalls: [{ toolName: 'emitChart', input: { resultId: 'totals', title: 'Totals', spec } }] },
      { text: '' },
    );
    const conversation = await h.core.conversations.startWeb(MEMBER);
    const pinned = h.core.pinnedQueries.pin(await h.core.conversations.ask(MEMBER, conversation.id, 'Chart sales'));
    await pgDb.sql("INSERT INTO orders VALUES (4, 'south', 5)");

    const run = await h.core.pinnedQueries.run(pinned);

    expect(pinned.layout).toEqual([{ type: 'chart', resultId: 'totals', title: 'Totals', spec }]);
    expect(run.blocks).toEqual([
      {
        status: 'ok',
        block: {
          type: 'chart',
          kind: 'bar',
          title: 'Totals',
          resultId: 'totals',
          spec,
          data: [
            { region: 'north', total: 17.75, orders: 2 },
            { region: 'south', total: 25, orders: 2 },
          ],
          truncated: false,
        },
      },
    ]);
  });

  test('a Pinned Query broken by a schema change fails visibly; blocks it does not feed are still rebuilt', async () => {
    const pinned = h.core.pinnedQueries.pin(await answerTotals());
    await pgDb.sql('ALTER TABLE orders RENAME COLUMN amount TO amount_eur');

    const run = await h.core.pinnedQueries.run(pinned);

    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/"totals" failed: .*amount/);
    expect(run.queries).toMatchObject([{ resultId: 'totals', ok: false, error: expect.stringContaining('amount') }]);
    expect(run.blocks).toMatchObject([
      { status: 'ok', block: { type: 'text', markdown: 'Sales by region:' } },
      { status: 'error', error: expect.stringContaining('amount'), pinned: { type: 'table', resultId: 'totals' } },
    ]);
  });

  test('a table keeps the columns the agent selected, in its order', async () => {
    const answer = await answerTotals({ resultId: 'totals', columns: ['orders', 'region'] });
    expect(answer.blocks[1]).toMatchObject({ columns: [{ name: 'orders' }, { name: 'region' }], rows: [[2, 'north'], [1, 'south']] });

    await pgDb.sql("INSERT INTO orders VALUES (4, 'south', 5)");
    const run = await h.core.pinnedQueries.run(h.core.pinnedQueries.pin(answer));

    expect(run.blocks[1]).toMatchObject({
      status: 'ok',
      block: { columns: [{ name: 'orders' }, { name: 'region' }], rows: [[2, 'north'], [2, 'south']] },
    });
  });

  test('a Data Source that is no longer exposed to the agent makes its Pinned Queries fail', async () => {
    const pinned = h.core.pinnedQueries.pin(await answerTotals());
    await h.core.dataSources.setExposedDatasets(ADMIN, warehouseId, []);

    const run = await h.core.pinnedQueries.run(pinned);

    expect(run.status).toBe('failed');
    expect(run.queries).toMatchObject([{ ok: false, error: 'The Data Source "Warehouse" is no longer available.' }]);
  });

  test('only successful queries are pinned', async () => {
    h.llm.script(
      { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query: 'SELECT nope FROM orders', name: 'totals' } }] },
      { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query: TOTALS_SQL, name: 'totals' } }] },
      { toolCalls: [{ toolName: 'emitTable', input: { resultId: 'totals_2' } }] },
      { text: '' },
    );
    const conversation = await h.core.conversations.startWeb(MEMBER);
    const answer = await h.core.conversations.ask(MEMBER, conversation.id, 'Sales?');

    const pinned = h.core.pinnedQueries.pin(answer);

    expect(pinned.queries).toEqual([
      { resultId: 'totals_2', dataSourceId: warehouseId, dataSourceName: 'Warehouse', language: 'sql', query: TOTALS_SQL },
    ]);
    expect(pinned.layout).toEqual([{ type: 'table', resultId: 'totals_2', columns: ['region', 'total', 'orders'] }]);
  });

  test('an Answer without query results, or a failed one, cannot be pinned', async () => {
    h.llm.script({ toolCalls: [{ toolName: 'emitText', input: { markdown: 'Hello.' } }] }, { text: '' });
    const conversation = await h.core.conversations.startWeb(MEMBER);
    const textOnly = await h.core.conversations.ask(MEMBER, conversation.id, 'Hi');

    expect(() => h.core.pinnedQueries.pin(textOnly)).toThrow(ValidationError);
    expect(() => h.core.pinnedQueries.pin({ ...textOnly, status: 'failed', error: 'x' })).toThrow(ValidationError);
  });

  test('tables of Answers stored before Pinned Queries (no resultId) are left out of the layout', async () => {
    const answer = await answerTotals();
    const legacy: Answer = {
      ...answer,
      blocks: answer.blocks.map((b) => (b.type === 'table' ? { ...b, resultId: undefined } : b)),
    };

    expect(() => h.core.pinnedQueries.pin(legacy)).toThrow(ValidationError);
  });
});
