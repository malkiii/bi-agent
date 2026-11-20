import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createTestHarness, type TestHarness } from '@/core/testing';
import { CONTRACT_FIXTURE_SQL, createPostgresTestDatabase, type PostgresTestDatabase } from '@/drivers/postgres/testing';
import { OPEN_IN_DASHBOARD_ACTION_ID, SHOW_QUERY_ACTION_ID } from './render';

const ADMIN = 'UADMIN';
const ADA = 'UADA';
const BOB = 'UBOB';
const BOT = 'UBOT';
const CHANNEL = 'CSALES';

let pgDb: PostgresTestDatabase;
beforeAll(async () => {
  pgDb = await createPostgresTestDatabase();
  await pgDb.sql(CONTRACT_FIXTURE_SQL);
});
afterAll(() => pgDb.drop());

let h: TestHarness;
let warehouseId: string;
beforeEach(async () => {
  h = await createTestHarness({ config: { slackTeamId: 'T1', adminSlackUserIds: [ADMIN], appUrl: 'https://botley.example' } });
  await h.core.users.signIn({ slackUserId: ADMIN, slackTeamId: 'T1', name: 'Admin', email: null, image: null });
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

const NORTH_SQL = "SELECT region, sum(amount) AS total FROM orders WHERE region = 'north' GROUP BY region";

function scriptNorthAnswer() {
  h.llm.script(
    { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query: NORTH_SQL, name: 'north' } }] },
    {
      toolCalls: [
        { toolName: 'emitText', input: { markdown: 'North sold **17.75**.' } },
        { toolName: 'emitTable', input: { resultId: 'north' } },
      ],
    },
    { text: '' },
  );
}

type Block = { type: string; [key: string]: unknown };

describe('answering an @mention in a channel', () => {
  test('👀 on the Prompt, then a placeholder in the thread that is edited into the Answer', async () => {
    scriptNorthAnswer();

    await h.core.slackBot.handlePrompt({ userId: ADA, channel: CHANNEL, ts: '100.1', text: `<@${BOT}> north sales?`, botUserId: BOT });

    expect(h.slack.reactions).toEqual([{ channel: CHANNEL, ts: '100.1', emoji: 'eyes' }]);
    const replies = h.slack.thread(CHANNEL, '100.1');
    expect(replies).toHaveLength(1);
    const reply = replies[0]!;
    expect(reply.history[0]?.text).toMatch(/thinking/i);
    expect(reply.history.map((v) => v.text)).toContainEqual(expect.stringContaining('Querying Warehouse…'));
    expect(reply.text).toBe('North sold *17.75*.');
    const blocks = reply.blocks as Block[];
    expect(blocks.map((b) => b.type)).toEqual(['section', 'table', 'context', 'actions']);
    expect(blocks[2]).toMatchObject({ elements: [{ text: 'Sources: Warehouse (public.orders)' }] });
  });

  test('the Conversation is saved with a Slack Source and the poster as Participant', async () => {
    scriptNorthAnswer();

    await h.core.slackBot.handlePrompt({ userId: ADA, channel: CHANNEL, ts: '100.1', text: `<@${BOT}> north sales?`, botUserId: BOT });

    const [conversation] = await h.core.conversations.list(ADA);
    expect(conversation).toMatchObject({
      source: { kind: 'slack', channel: CHANNEL, threadTs: '100.1' },
      participants: [ADA],
      title: 'north sales?',
    });
    const { messages } = await h.core.conversations.get(ADA, conversation!.id);
    expect(messages.map((m) => m.kind)).toEqual(['prompt', 'answer']);
  });

  test('a follow-up in the thread continues the Conversation with context and records the new Participant', async () => {
    scriptNorthAnswer();
    await h.core.slackBot.handlePrompt({ userId: ADA, channel: CHANNEL, ts: '100.1', text: `<@${BOT}> north sales?`, botUserId: BOT });
    h.llm.script({ text: 'Same as before.' });

    await h.core.slackBot.handlePrompt({
      userId: BOB,
      channel: CHANNEL,
      ts: '100.5',
      threadTs: '100.1',
      text: `<@${BOT}> and again?`,
      botUserId: BOT,
    });

    const prompt = JSON.stringify(h.llm.model.doStreamCalls[0]?.prompt);
    expect(prompt).toContain('north sales?');
    expect(prompt).toContain('North sold **17.75**.');
    const [conversation] = await h.core.conversations.list(BOB);
    expect(conversation?.participants).toEqual([ADA, BOB]);
    expect(await h.core.conversations.list(ADA)).toHaveLength(1);
    expect(h.slack.thread(CHANNEL, '100.1').map((m) => m.text)).toEqual(['North sold *17.75*.', 'Same as before.']);
    expect(h.slack.reactions.at(-1)).toEqual({ channel: CHANNEL, ts: '100.5', emoji: 'eyes' });
  });

  test('the same Slack event delivered twice is answered once', async () => {
    scriptNorthAnswer();
    const prompt = { userId: ADA, channel: CHANNEL, ts: '100.1', text: `<@${BOT}> north sales?`, botUserId: BOT };

    await Promise.all([h.core.slackBot.handlePrompt(prompt), h.core.slackBot.handlePrompt(prompt)]);

    expect(h.slack.thread(CHANNEL, '100.1')).toHaveLength(1);
  });

  test('a bare mention gets a hint instead of an Answer', async () => {
    await h.core.slackBot.handlePrompt({ userId: ADA, channel: CHANNEL, ts: '100.1', text: `<@${BOT}>`, botUserId: BOT });

    expect(h.slack.thread(CHANNEL, '100.1')).toMatchObject([{ text: expect.stringMatching(/ask me/i) }]);
    expect(h.llm.model.doStreamCalls).toHaveLength(0);
  });
});

describe('DMs', () => {
  test('a top-level DM is answered in its own thread', async () => {
    h.llm.script({ text: 'Hello!' });

    await h.core.slackBot.handlePrompt({ userId: ADA, channel: 'D123', ts: '200.1', text: 'hi there' });

    expect(h.slack.thread('D123', '200.1')).toMatchObject([{ text: 'Hello!' }]);
    const [conversation] = await h.core.conversations.list(ADA);
    expect(conversation?.source).toEqual({ kind: 'slack', channel: 'D123', threadTs: '200.1' });
  });
});

describe('failures', () => {
  test('a failed Answer gets ❌ and a readable error in place of the placeholder', async () => {
    h.llm.script();

    await h.core.slackBot.handlePrompt({ userId: ADA, channel: CHANNEL, ts: '100.1', text: `<@${BOT}> anything`, botUserId: BOT });

    expect(h.slack.reactions).toEqual([
      { channel: CHANNEL, ts: '100.1', emoji: 'eyes' },
      { channel: CHANNEL, ts: '100.1', emoji: 'x' },
    ]);
    expect(h.slack.thread(CHANNEL, '100.1')).toMatchObject([{ text: expect.stringContaining('Sorry') }]);
  });

  test('a rejected Prompt (too long) gets ❌ and the reason', async () => {
    await h.core.slackBot.handlePrompt({ userId: ADA, channel: CHANNEL, ts: '100.1', text: 'x'.repeat(9_000) });

    expect(h.slack.reactions.at(-1)).toMatchObject({ emoji: 'x' });
    expect(h.slack.thread(CHANNEL, '100.1')).toMatchObject([{ text: expect.stringMatching(/limited to/) }]);
  });
});

describe('"Show query"', () => {
  test('the button opens a modal with the exact queries of that Answer', async () => {
    scriptNorthAnswer();
    await h.core.slackBot.handlePrompt({ userId: ADA, channel: CHANNEL, ts: '100.1', text: `<@${BOT}> north sales?`, botUserId: BOT });
    const actions = (h.slack.thread(CHANNEL, '100.1')[0]!.blocks as Block[]).find((b) => b.type === 'actions');
    const button = (actions?.elements as { action_id: string; value: string }[])[0]!;
    expect(button.action_id).toBe(SHOW_QUERY_ACTION_ID);

    await h.core.slackBot.showQuery({ triggerId: 'trig1', value: button.value });

    expect(h.slack.modals).toHaveLength(1);
    expect(h.slack.modals[0]).toMatchObject({ triggerId: 'trig1', view: { type: 'modal' } });
    expect(JSON.stringify(h.slack.modals[0]!.view)).toContain(NORTH_SQL);
  });
});

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
const SERIES_SQL = 'SELECT g AS n, g * 2 AS doubled FROM generate_series(1, 40) AS g';

describe('charts and long tables', () => {
  test('each chart is uploaded to the thread as a PNG after the Answer', async () => {
    h.llm.script(
      { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query: NORTH_SQL, name: 'north' } }] },
      {
        toolCalls: [
          {
            toolName: 'emitChart',
            input: {
              resultId: 'north',
              title: 'North sales',
              spec: { mark: 'bar', encoding: { x: { field: 'region', type: 'nominal' }, y: { field: 'total', type: 'quantitative' } } },
            },
          },
        ],
      },
      { text: '' },
    );

    await h.core.slackBot.handlePrompt({ userId: ADA, channel: CHANNEL, ts: '100.1', text: `<@${BOT}> chart north`, botUserId: BOT });

    expect(h.slack.uploads).toHaveLength(1);
    const [upload] = h.slack.uploads;
    expect(upload).toMatchObject({ channel: CHANNEL, threadTs: '100.1', files: [{ filename: 'north-sales.png', title: 'North sales' }] });
    expect([...upload!.files[0]!.content.subarray(0, 4)]).toEqual(PNG_SIGNATURE);
    expect(JSON.stringify(h.slack.thread(CHANNEL, '100.1')[0]!.blocks)).toContain('North sales');
  });

  test('a table over the inline limit shows 10 rows and gets its CSV and XLSX attached', async () => {
    h.llm.script(
      { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query: SERIES_SQL, name: 'series' } }] },
      { toolCalls: [{ toolName: 'emitTable', input: { resultId: 'series', title: 'Series' } }] },
      { text: '' },
    );

    await h.core.slackBot.handlePrompt({ userId: ADA, channel: CHANNEL, ts: '100.1', text: `<@${BOT}> numbers`, botUserId: BOT });

    const table = (h.slack.thread(CHANNEL, '100.1')[0]!.blocks as Block[]).find((b) => b.type === 'table') as unknown as { rows: unknown[] };
    expect(table.rows).toHaveLength(11);
    expect(h.slack.uploads).toHaveLength(1);
    const files = h.slack.uploads[0]!.files;
    expect(files.map((f) => f.filename)).toEqual(['series.csv', 'series.xlsx']);
    const csv = new TextDecoder().decode(files[0]!.content);
    expect(csv.trim().split('\r\n')).toHaveLength(41);
    expect([...files[1]!.content.subarray(0, 2)]).toEqual([0x50, 0x4b]); // a zip (XLSX)
  });

  test('short tables and plain text upload nothing', async () => {
    scriptNorthAnswer();

    await h.core.slackBot.handlePrompt({ userId: ADA, channel: CHANNEL, ts: '100.1', text: `<@${BOT}> north sales?`, botUserId: BOT });

    expect(h.slack.uploads).toEqual([]);
  });

  test('a failed upload is reported in the thread but the Answer stays', async () => {
    h.llm.script(
      { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query: SERIES_SQL, name: 'series' } }] },
      { toolCalls: [{ toolName: 'emitTable', input: { resultId: 'series' } }] },
      { text: '' },
    );
    h.slack.failUploads = true;

    await h.core.slackBot.handlePrompt({ userId: ADA, channel: CHANNEL, ts: '100.1', text: `<@${BOT}> numbers`, botUserId: BOT });

    const thread = h.slack.thread(CHANNEL, '100.1');
    expect(thread).toHaveLength(2);
    expect(thread[1]!.text).toMatch(/could not attach/i);
    expect(h.slack.reactions.map((r) => r.emoji)).toEqual(['eyes']);
  });
});

describe('"Open in dashboard"', () => {
  test('the Answer links to a Fork of its Conversation in the web app', async () => {
    scriptNorthAnswer();

    await h.core.slackBot.handlePrompt({ userId: ADA, channel: CHANNEL, ts: '100.1', text: `<@${BOT}> north sales?`, botUserId: BOT });

    const [conversation] = await h.core.conversations.list(ADA);
    const actions = (h.slack.thread(CHANNEL, '100.1')[0]!.blocks as Block[]).find((b) => b.type === 'actions');
    expect(actions?.elements).toContainEqual(
      expect.objectContaining({ action_id: OPEN_IN_DASHBOARD_ACTION_ID, url: `https://botley.example/chat/fork/${conversation!.id}` }),
    );
  });
});
