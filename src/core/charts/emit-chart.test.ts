import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createTestHarness, type TestHarness } from '@/core/testing';
import { CONTRACT_FIXTURE_SQL, createPostgresTestDatabase, type PostgresTestDatabase } from '@/drivers/postgres/testing';

const ADMIN = 'UADMIN';
const MEMBER = 'UMEMBER';

let pgDb: PostgresTestDatabase;
beforeAll(async () => {
  pgDb = await createPostgresTestDatabase();
  await pgDb.sql(CONTRACT_FIXTURE_SQL);
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

const BY_REGION_SQL = 'SELECT region, sum(amount) AS total FROM orders GROUP BY region ORDER BY region';

const BAR_SPEC = {
  mark: 'bar',
  encoding: {
    x: { field: 'region', type: 'nominal' },
    y: { field: 'total', type: 'quantitative' },
  },
};

async function askWithChart(spec: unknown) {
  h.llm.script(
    { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query: BY_REGION_SQL, name: 'by_region' } }] },
    { toolCalls: [{ toolName: 'emitChart', input: { resultId: 'by_region', title: 'Sales by region', spec } }] },
    { text: '' },
  );
  const conversation = await h.core.conversations.startWeb(MEMBER);
  const answer = await h.core.conversations.ask(MEMBER, conversation.id, 'Chart sales by region');
  return { answer, conversation };
}

/** What the model got back from the emitChart call. */
function emitChartResult(): unknown {
  const prompt = JSON.stringify(h.llm.model.doStreamCalls.at(-1)?.prompt);
  const match = /"toolName":"emitChart".*?"output":\{"type":"json","value":(\{[^}]*\})/.exec(prompt);
  return match ? JSON.parse(match[1]!) : undefined;
}

describe('emitChart', () => {
  test('stores a Chart Result Block with the Vega-Lite spec, its kind and the result rows it draws', async () => {
    const { answer, conversation } = await askWithChart(BAR_SPEC);

    expect(answer.status).toBe('complete');
    expect(answer.blocks).toEqual([
      {
        type: 'chart',
        kind: 'bar',
        title: 'Sales by region',
        resultId: 'by_region',
        spec: BAR_SPEC,
        data: [
          { region: 'north', total: 17.75 },
          { region: 'south', total: 20 },
        ],
        truncated: false,
      },
    ]);
    const { messages } = await h.core.conversations.get(MEMBER, conversation.id);
    expect(messages.at(-1)).toMatchObject({ kind: 'answer', answer: { blocks: [{ type: 'chart', kind: 'bar' }] } });
  });

  test.each([
    ['line', { mark: 'line', encoding: { x: { field: 'region', type: 'ordinal' }, y: { field: 'total', type: 'quantitative' } } }],
    ['area', { mark: { type: 'area' }, encoding: { x: { field: 'region', type: 'ordinal' }, y: { field: 'total', type: 'quantitative' } } }],
    ['pie', { mark: { type: 'arc', innerRadius: 40 }, encoding: { theta: { field: 'total', type: 'quantitative' }, color: { field: 'region', type: 'nominal' } } }],
    ['scatter', { mark: 'point', encoding: { x: { field: 'region', type: 'nominal' }, y: { field: 'total', type: 'quantitative' } } }],
    ['big-number', { mark: 'text', encoding: { text: { aggregate: 'sum', field: 'total', type: 'quantitative' } } }],
  ])('a %s chart is accepted', async (kind, spec) => {
    const { answer } = await askWithChart(spec);

    expect(answer.blocks).toMatchObject([{ type: 'chart', kind }]);
  });

  test.each([
    ['an unknown field', { ...BAR_SPEC, encoding: { ...BAR_SPEC.encoding, y: { field: 'revenue', type: 'quantitative' } } }, /revenue/],
    ['an unsupported mark', { ...BAR_SPEC, mark: 'geoshape' }, /mark/i],
    ['its own data', { ...BAR_SPEC, data: { url: 'https://example.com/data.json' } }, /data/],
    ['a URL anywhere', { ...BAR_SPEC, encoding: { ...BAR_SPEC.encoding, href: { value: 'https://example.com' } } }, /href|url/i],
  ])('a spec with %s is refused back to the model and no block is added', async (_, spec, error) => {
    const { answer } = await askWithChart(spec);

    expect(answer.blocks).toEqual([]);
    expect(emitChartResult()).toMatchObject({ ok: false, error: expect.stringMatching(error) });
  });
});
