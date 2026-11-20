import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createTestHarness, type TestHarness } from '@/core/testing';
import { NotFoundError, ValidationError, type AnswerEvent } from '@/core';
import { CONTRACT_FIXTURE_SQL, createPostgresTestDatabase, type PostgresTestDatabase } from '@/drivers/postgres/testing';

const ADMIN = 'UADMIN';
const MEMBER = 'UMEMBER';
const OTHER = 'UOTHER';

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
  for (const slackUserId of [ADMIN, MEMBER, OTHER]) {
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

const NORTH_SQL = "SELECT region, sum(amount) AS total FROM orders WHERE region = 'north' GROUP BY region";

describe('answering a Prompt in a web Conversation', () => {
  test('a member gets an Answer with Text and Table Result Blocks, the sources used and the executed query', async () => {
    h.llm.script(
      { toolCalls: [{ toolName: 'listDatasets', input: {} }] },
      { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query: NORTH_SQL, name: 'north' } }] },
      {
        toolCalls: [
          { toolName: 'emitText', input: { markdown: 'North sold **17.75**.' } },
          { toolName: 'emitTable', input: { resultId: 'north', title: 'North total' } },
        ],
      },
      { text: '' },
    );

    const conversation = await h.core.conversations.startWeb(MEMBER);
    const answer = await h.core.conversations.ask(MEMBER, conversation.id, 'How much did north sell?');

    expect(answer.status).toBe('complete');
    expect(answer.blocks).toEqual([
      { type: 'text', markdown: 'North sold **17.75**.' },
      {
        type: 'table',
        title: 'North total',
        columns: [
          { name: 'region', type: 'string' },
          { name: 'total', type: 'number' },
        ],
        rows: [['north', 17.75]],
        truncated: false,
      },
    ]);
    expect(answer.sources).toEqual([{ dataSourceId: warehouseId, name: 'Warehouse', datasets: ['public.orders'] }]);
    expect(answer.queries).toMatchObject([
      { dataSourceId: warehouseId, dataSourceName: 'Warehouse', language: 'sql', query: NORTH_SQL, ok: true, rowCount: 1 },
    ]);
  });

  test('progress, executed queries and Result Blocks are reported as they happen', async () => {
    h.llm.script(
      { toolCalls: [{ toolName: 'listDatasets', input: {} }] },
      { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query: NORTH_SQL } }] },
      { toolCalls: [{ toolName: 'emitText', input: { markdown: 'Done.' } }] },
      { text: '' },
    );
    const events: AnswerEvent[] = [];

    const conversation = await h.core.conversations.startWeb(MEMBER);
    await h.core.conversations.ask(MEMBER, conversation.id, 'North?', { onEvent: (e) => events.push(e) });

    expect(events.map((e) => e.type)).toEqual(['progress', 'progress', 'query', 'block']);
    expect(events[1]).toEqual({ type: 'progress', label: 'Querying Warehouse…' });
  });

  test('a failing query goes back to the model, which corrects it', async () => {
    const broken = 'SELECT regoin FROM orders';
    const fixed = 'SELECT region FROM orders ORDER BY id';
    h.llm.script(
      { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query: broken, name: 'regions' } }] },
      { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query: fixed, name: 'regions' } }] },
      { toolCalls: [{ toolName: 'emitTable', input: { resultId: 'regions_2' } }] },
      { text: '' },
    );

    const conversation = await h.core.conversations.startWeb(MEMBER);
    const answer = await h.core.conversations.ask(MEMBER, conversation.id, 'Which regions?');

    expect(answer.queries).toMatchObject([
      { query: broken, ok: false, error: expect.stringContaining('regoin') },
      { query: fixed, ok: true, rowCount: 3, resultId: 'regions_2' },
    ]);
    const secondCall = JSON.stringify(h.llm.model.doStreamCalls[1]?.prompt);
    expect(secondCall).toContain('regoin');
    expect(answer.blocks).toMatchObject([{ type: 'table', rows: [['north'], ['south'], ['north']] }]);
    expect(answer.sources).toEqual([{ dataSourceId: warehouseId, name: 'Warehouse', datasets: ['public.orders'] }]);
  });

  test('after too many failed queries runQuery stops running them', async () => {
    h.llm.script(
      { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query: 'SELECT nope FROM orders' } }] },
    );

    const conversation = await h.core.conversations.startWeb(MEMBER);
    const answer = await h.core.conversations.ask(MEMBER, conversation.id, 'Loop forever');

    expect(answer.queries.filter((q) => !q.ok)).toHaveLength(4);
    expect(answer.status).toBe('complete');
  });

  test('when the model fails, a failed Answer with a friendly message is stored', async () => {
    h.llm.script();

    const conversation = await h.core.conversations.startWeb(MEMBER);
    const answer = await h.core.conversations.ask(MEMBER, conversation.id, 'Anything');

    expect(answer).toMatchObject({ status: 'failed', error: expect.stringContaining('Sorry'), blocks: [] });
    const { messages } = await h.core.conversations.get(MEMBER, conversation.id);
    expect(messages.map((m) => m.kind)).toEqual(['prompt', 'answer']);
  });
});

describe('Conversation history', () => {
  test('the Conversation and its messages are saved and can be reopened by the Participant', async () => {
    h.llm.script({ toolCalls: [{ toolName: 'emitText', input: { markdown: 'Hello!' } }] }, { text: '' });

    const started = await h.core.conversations.startWeb(MEMBER);
    h.clock.advance(1_000);
    const answer = await h.core.conversations.ask(MEMBER, started.id, 'Say hello');

    const reopened = await h.core.conversations.get(MEMBER, started.id);
    expect(reopened.conversation).toMatchObject({
      id: started.id,
      source: { kind: 'web' },
      title: 'Say hello',
      participants: [MEMBER],
    });
    expect(reopened.messages).toMatchObject([
      { kind: 'prompt', authorSlackUserId: MEMBER, text: 'Say hello' },
      { kind: 'answer', answer },
    ]);
    expect((await h.core.conversations.list(MEMBER)).map((c) => c.id)).toEqual([started.id]);
  });

  test('people who are not Participants can neither see nor use the Conversation', async () => {
    h.llm.script({ text: 'Hi' });
    const conversation = await h.core.conversations.startWeb(MEMBER);
    await h.core.conversations.ask(MEMBER, conversation.id, 'Hello');

    await expect(h.core.conversations.get(OTHER, conversation.id)).rejects.toThrow(NotFoundError);
    await expect(h.core.conversations.ask(OTHER, conversation.id, 'Me too')).rejects.toThrow(NotFoundError);
    expect(await h.core.conversations.list(OTHER)).toEqual([]);
  });

  test('empty Conversations are not listed, and empty Prompts are refused', async () => {
    const conversation = await h.core.conversations.startWeb(MEMBER);

    await expect(h.core.conversations.ask(MEMBER, conversation.id, '   ')).rejects.toThrow(ValidationError);
    expect(await h.core.conversations.list(MEMBER)).toEqual([]);
  });

  test('a follow-up Prompt gets the earlier Prompts and Answers as context', async () => {
    h.llm.script(
      { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query: NORTH_SQL, name: 'north' } }] },
      { toolCalls: [{ toolName: 'emitText', input: { markdown: 'North sold 17.75.' } }] },
      { text: '' },
    );
    const conversation = await h.core.conversations.startWeb(MEMBER);
    await h.core.conversations.ask(MEMBER, conversation.id, 'How much did north sell?');

    h.llm.script({ text: 'South sold 20.' });
    const followUp = await h.core.conversations.ask(MEMBER, conversation.id, 'And south?');

    const prompt = JSON.stringify(h.llm.model.doStreamCalls[0]?.prompt);
    expect(prompt).toContain('How much did north sell?');
    expect(prompt).toContain('North sold 17.75.');
    expect(prompt).toContain('SELECT region, sum(amount)');
    expect(followUp.blocks).toEqual([{ type: 'text', markdown: 'South sold 20.' }]);
  });
});
