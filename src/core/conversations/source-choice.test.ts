import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createTestHarness, type TestHarness } from '@/core/testing';
import { CONTRACT_FIXTURE_SQL, createPostgresTestDatabase, type PostgresTestDatabase } from '@/drivers/postgres/testing';

const ADMIN = 'UADMIN';
const MEMBER = 'UMEMBER';

let warehouseDb: PostgresTestDatabase;
let crmDb: PostgresTestDatabase;
beforeAll(async () => {
  [warehouseDb, crmDb] = await Promise.all([createPostgresTestDatabase(), createPostgresTestDatabase()]);
  await warehouseDb.sql(CONTRACT_FIXTURE_SQL);
  await crmDb.sql(`
    CREATE TABLE managers (region text PRIMARY KEY, manager text NOT NULL);
    INSERT INTO managers VALUES ('north', 'Nadia'), ('south', 'Sami');
  `);
});
afterAll(() => Promise.all([warehouseDb.drop(), crmDb.drop()]));

let h: TestHarness;
let warehouseId: string;
let crmId: string;

async function addPostgres(name: string, db: PostgresTestDatabase, exposed: string) {
  const { host, port, database, user, password } = db.connection;
  const ds = await h.core.dataSources.create(ADMIN, {
    name,
    kind: 'postgres',
    config: { host, port, database, user, sslMode: 'disable' },
    secrets: { password },
  });
  await h.core.dataSources.refreshSchema(ADMIN, ds.id);
  await h.core.dataSources.setExposedDatasets(ADMIN, ds.id, [exposed]);
  return ds.id;
}

beforeEach(async () => {
  h = await createTestHarness({ config: { slackTeamId: 'T1', adminSlackUserIds: [ADMIN] } });
  for (const slackUserId of [ADMIN, MEMBER]) {
    await h.core.users.signIn({ slackUserId, slackTeamId: 'T1', name: slackUserId, email: null, image: null });
  }
  warehouseId = await addPostgres('Warehouse', warehouseDb, 'public.orders');
  crmId = await addPostgres('CRM', crmDb, 'public.managers');
});
afterEach(() => h.close());

/** The Data Source names listDatasets returned to the model in the given model call. */
function listedSourceNames(call: number): string[] {
  const prompt = h.llm.model.doStreamCalls[call]?.prompt ?? [];
  for (const message of prompt) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type === 'tool-result' && part.toolName === 'listDatasets' && part.output.type === 'json') {
        return (part.output.value as { name: string }[]).map((ds) => ds.name);
      }
    }
  }
  throw new Error(`No listDatasets result in model call ${call}`);
}

const NORTH_SQL = "SELECT region, sum(amount) AS total FROM orders WHERE region = 'north' GROUP BY region";

describe('locking a web Conversation to Data Sources', () => {
  test('without a lock the agent sees every Data Source with Exposed Datasets', async () => {
    h.llm.script({ toolCalls: [{ toolName: 'listDatasets', input: {} }] }, { text: 'ok' });

    const conversation = await h.core.conversations.startWeb(MEMBER);
    await h.core.conversations.ask(MEMBER, conversation.id, 'What can you see?');

    expect(listedSourceNames(1).sort()).toEqual(['CRM', 'Warehouse']);
  });

  test('a Conversation locked to one Data Source only sees and queries that one', async () => {
    h.llm.script(
      { toolCalls: [{ toolName: 'listDatasets', input: {} }] },
      { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query: NORTH_SQL } }] },
      { text: 'ok' },
    );

    const conversation = await h.core.conversations.startWeb(MEMBER, { dataSourceIds: [crmId] });
    const answer = await h.core.conversations.ask(MEMBER, conversation.id, 'North sales?');

    expect(conversation.lockedDataSourceIds).toEqual([crmId]);
    expect(listedSourceNames(1)).toEqual(['CRM']);
    expect(answer.queries).toEqual([]);
    expect(JSON.stringify(h.llm.model.doStreamCalls[2]?.prompt)).toContain('Unknown Data Source');
  });

  test('the lock can be changed or removed later, and is kept with the Conversation', async () => {
    const conversation = await h.core.conversations.startWeb(MEMBER);

    await h.core.conversations.lock(MEMBER, conversation.id, [warehouseId]);
    expect((await h.core.conversations.get(MEMBER, conversation.id)).conversation.lockedDataSourceIds).toEqual([warehouseId]);

    h.llm.script({ toolCalls: [{ toolName: 'listDatasets', input: {} }] }, { text: 'ok' });
    await h.core.conversations.ask(MEMBER, conversation.id, 'What can you see?');
    expect(listedSourceNames(1)).toEqual(['Warehouse']);

    const unlocked = await h.core.conversations.lock(MEMBER, conversation.id, []);
    expect(unlocked.lockedDataSourceIds).toBeUndefined();
  });

  test('only existing Data Sources can be chosen, and only by a Participant', async () => {
    const conversation = await h.core.conversations.startWeb(MEMBER);

    await expect(h.core.conversations.lock(MEMBER, conversation.id, ['nope'])).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(h.core.conversations.lock(ADMIN, conversation.id, [crmId])).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('Channel Defaults', () => {
  const FINANCE = 'CFINANCE';
  const RANDOM = 'CRANDOM';

  function scriptListOnly() {
    h.llm.script({ toolCalls: [{ toolName: 'listDatasets', input: {} }] }, { text: 'ok' });
  }

  test('admins set, list and remove the Data Sources preferred in a Slack channel', async () => {
    h.slack.botChannels.add(FINANCE);
    h.slack.channelNames.set(FINANCE, 'finance');
    expect(await h.core.channelDefaults.slackChannels(ADMIN)).toEqual([{ id: FINANCE, name: 'finance' }]);

    await h.core.channelDefaults.set(ADMIN, FINANCE, [warehouseId]);
    expect(await h.core.channelDefaults.list(ADMIN)).toMatchObject([
      { channel: FINANCE, channelName: 'finance', dataSourceIds: [warehouseId], updatedBy: ADMIN },
    ]);

    await h.core.channelDefaults.set(ADMIN, FINANCE, [warehouseId, crmId]);
    expect(await h.core.channelDefaults.list(ADMIN)).toMatchObject([{ channel: FINANCE, dataSourceIds: [warehouseId, crmId] }]);

    await h.core.channelDefaults.remove(ADMIN, FINANCE);
    expect(await h.core.channelDefaults.list(ADMIN)).toEqual([]);
  });

  test('members cannot manage Channel Defaults, and only existing Data Sources can be chosen', async () => {
    await expect(h.core.channelDefaults.list(MEMBER)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.core.channelDefaults.set(MEMBER, FINANCE, [crmId])).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.core.channelDefaults.set(ADMIN, FINANCE, [])).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(h.core.channelDefaults.set(ADMIN, FINANCE, ['nope'])).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(h.core.channelDefaults.set(ADMIN, 'not a channel', [crmId])).rejects.toMatchObject({ code: 'invalid_input' });
  });

  test("Prompts in a channel with a Channel Default only see that channel's Data Sources", async () => {
    await h.core.channelDefaults.set(ADMIN, FINANCE, [warehouseId]);

    scriptListOnly();
    await h.core.slackBot.handlePrompt({ userId: MEMBER, channel: FINANCE, ts: '100.1', text: 'What can you see?' });
    expect(listedSourceNames(1)).toEqual(['Warehouse']);

    scriptListOnly();
    await h.core.slackBot.handlePrompt({ userId: MEMBER, channel: RANDOM, ts: '100.2', text: 'What can you see?' });
    expect(listedSourceNames(1).sort()).toEqual(['CRM', 'Warehouse']);
  });

  test('queries against a Data Source outside the Channel Default are refused', async () => {
    await h.core.channelDefaults.set(ADMIN, FINANCE, [crmId]);
    h.llm.script(
      { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query: NORTH_SQL } }] },
      { text: 'ok' },
    );

    await h.core.slackBot.handlePrompt({ userId: MEMBER, channel: FINANCE, ts: '100.1', text: 'North sales?' });

    expect(JSON.stringify(h.llm.model.doStreamCalls[1]?.prompt)).toContain('Unknown Data Source');
  });

  test('when no Channel Default Data Source can be queried any more, the agent chooses among all of them', async () => {
    await h.core.channelDefaults.set(ADMIN, FINANCE, [warehouseId]);
    await h.core.dataSources.setExposedDatasets(ADMIN, warehouseId, []);

    scriptListOnly();
    await h.core.slackBot.handlePrompt({ userId: MEMBER, channel: FINANCE, ts: '100.1', text: 'What can you see?' });

    expect(listedSourceNames(1)).toEqual(['CRM']);
  });
});

describe('combining results from several Data Sources', () => {
  const SALES_SQL = 'SELECT region, sum(amount) AS total FROM orders GROUP BY region';
  const MANAGERS_SQL = 'SELECT region, manager FROM managers';
  const JOIN_SQL = 'SELECT s.region, m.manager, s.total FROM sales s JOIN managers m USING (region) ORDER BY s.region';

  function scriptCrossSourceAnswer(joinSql = JOIN_SQL) {
    h.llm.script(
      { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query: SALES_SQL, name: 'sales' } }] },
      { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: crmId, query: MANAGERS_SQL, name: 'managers' } }] },
      { toolCalls: [{ toolName: 'combineResults', input: { resultIds: ['sales', 'managers'], sql: joinSql, name: 'by_manager' } }] },
      { toolCalls: [{ toolName: 'emitTable', input: { resultId: 'by_manager', title: 'Sales by manager' } }] },
      { text: '' },
    );
  }

  test('one Answer joins results from two different Data Sources', async () => {
    scriptCrossSourceAnswer();

    const conversation = await h.core.conversations.startWeb(MEMBER);
    const answer = await h.core.conversations.ask(MEMBER, conversation.id, 'Sales by regional manager?');

    expect(answer.status).toBe('complete');
    expect(answer.blocks).toMatchObject([
      {
        type: 'table',
        title: 'Sales by manager',
        resultId: 'by_manager',
        columns: [
          { name: 'region', type: 'string' },
          { name: 'manager', type: 'string' },
          { name: 'total', type: 'number' },
        ],
        rows: [
          ['north', 'Nadia', 17.75],
          ['south', 'Sami', 20],
        ],
      },
    ]);
    expect(answer.sources).toEqual([
      { dataSourceId: warehouseId, name: 'Warehouse', datasets: ['public.orders'] },
      { dataSourceId: crmId, name: 'CRM', datasets: ['public.managers'] },
    ]);
    expect(answer.queries).toMatchObject([
      { resultId: 'sales', dataSourceId: warehouseId, ok: true },
      { resultId: 'managers', dataSourceId: crmId, ok: true },
      { resultId: 'by_manager', combines: ['sales', 'managers'], query: JOIN_SQL, ok: true, rowCount: 2 },
    ]);
  });

  test('a failing combination goes back to the model with the engine error', async () => {
    scriptCrossSourceAnswer('SELECT nope FROM sales');

    const conversation = await h.core.conversations.startWeb(MEMBER);
    const answer = await h.core.conversations.ask(MEMBER, conversation.id, 'Sales by regional manager?');

    expect(answer.queries[2]).toMatchObject({ resultId: 'by_manager', ok: false, error: expect.stringContaining('nope') });
    expect(JSON.stringify(h.llm.model.doStreamCalls[3]?.prompt)).toContain('nope');
  });

  test('combinations only read earlier results and cannot write or read files', async () => {
    scriptCrossSourceAnswer("SELECT * FROM read_csv('/etc/passwd')");

    const conversation = await h.core.conversations.startWeb(MEMBER);
    const answer = await h.core.conversations.ask(MEMBER, conversation.id, 'Sneaky');

    expect(answer.queries[2]).toMatchObject({ ok: false });
    expect(answer.blocks).toEqual([]);
  });

  test('a cross-source Answer re-runs as Pinned Queries with fresh data', async () => {
    scriptCrossSourceAnswer();
    const conversation = await h.core.conversations.startWeb(MEMBER);
    const answer = await h.core.conversations.ask(MEMBER, conversation.id, 'Sales by regional manager?');
    const pinned = h.core.pinnedQueries.pin(answer);

    await crmDb.sql("UPDATE managers SET manager = 'Nora' WHERE region = 'north'");
    try {
      const run = await h.core.pinnedQueries.run(pinned);

      expect(run.status).toBe('complete');
      expect(run.blocks).toMatchObject([
        { status: 'ok', block: { type: 'table', rows: [['north', 'Nora', 17.75], ['south', 'Sami', 20]] } },
      ]);
    } finally {
      await crmDb.sql("UPDATE managers SET manager = 'Nadia' WHERE region = 'north'");
    }
  });
});
