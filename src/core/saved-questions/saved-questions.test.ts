import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestHarness, type TestHarness } from '@/core/testing';
import { ForbiddenError, NotFoundError, ValidationError } from '@/core';
import { CONTRACT_FIXTURE_SQL, createPostgresTestDatabase, type PostgresTestDatabase } from '@/drivers/postgres/testing';

const ADMIN = 'UADMIN';
const MEMBER = 'UMEMBER';
const OTHER = 'UOTHER';

const TOTALS_SQL = 'SELECT region, sum(amount) AS total FROM orders GROUP BY region ORDER BY region';

let pgDb: PostgresTestDatabase;
let h: TestHarness;
let warehouseId: string;
beforeEach(async () => {
  pgDb = await createPostgresTestDatabase();
  await pgDb.sql(CONTRACT_FIXTURE_SQL);
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
afterEach(async () => {
  await h.close();
  await pgDb.drop();
});

/** MEMBER asks "Sales by region?" and gets a Table of `TOTALS_SQL`. */
async function answered() {
  h.llm.script(
    { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query: TOTALS_SQL, name: 'totals' } }] },
    { toolCalls: [{ toolName: 'emitTable', input: { resultId: 'totals', title: 'Totals' } }] },
    { text: '' },
  );
  const conversation = await h.core.conversations.startWeb(MEMBER);
  await h.core.conversations.ask(MEMBER, conversation.id, 'Sales by region?');
  const { messages } = await h.core.conversations.get(MEMBER, conversation.id);
  const answerMessage = messages.find((m) => m.kind === 'answer')!;
  return { conversationId: conversation.id, answerMessageId: answerMessage.id, promptMessageId: messages[0]!.id };
}

describe('Saved Questions', () => {
  test('saving an Answer creates a private Saved Question whose re-run gives fresh results in the same layout', async () => {
    const ref = await answered();

    const saved = await h.core.savedQuestions.save(MEMBER, ref);

    expect(saved).toMatchObject({
      title: 'Sales by region?',
      prompt: 'Sales by region?',
      ownerSlackUserId: MEMBER,
      visibility: 'private',
      lastRunAt: null,
      pinned: { queries: [{ resultId: 'totals', query: TOTALS_SQL }], layout: [{ type: 'table', resultId: 'totals' }] },
    });
    expect(await h.core.savedQuestions.list(MEMBER, { scope: 'mine' })).toMatchObject([{ id: saved.id }]);

    await pgDb.sql("INSERT INTO orders VALUES (4, 'south', 5)");
    h.clock.advance(60_000);
    const llmCalls = h.llm.model.doStreamCalls.length;
    const run = await h.core.savedQuestions.run(MEMBER, saved.id);

    expect(h.llm.model.doStreamCalls).toHaveLength(llmCalls);
    expect(run).toMatchObject({
      status: 'complete',
      blocks: [{ status: 'ok', block: { type: 'table', title: 'Totals', rows: [['north', 17.75], ['south', 25]] } }],
    });
    expect((await h.core.savedQuestions.get(MEMBER, saved.id)).lastRunAt).toEqual(h.clock.now());
  });

  test('a title and shared visibility can be given when saving', async () => {
    const saved = await h.core.savedQuestions.save(MEMBER, { ...(await answered()), title: ' Regional sales ', visibility: 'shared' });

    expect(saved).toMatchObject({ title: 'Regional sales', visibility: 'shared' });
  });

  test('only a Participant can save an Answer, and only an Answer message', async () => {
    const ref = await answered();

    await expect(h.core.savedQuestions.save(OTHER, ref)).rejects.toThrow(NotFoundError);
    await expect(h.core.savedQuestions.save(MEMBER, { ...ref, answerMessageId: ref.promptMessageId })).rejects.toThrow(NotFoundError);
  });

  test('an Answer without query results cannot be saved', async () => {
    h.llm.script({ toolCalls: [{ toolName: 'emitText', input: { markdown: 'Hello.' } }] }, { text: '' });
    const conversation = await h.core.conversations.startWeb(MEMBER);
    await h.core.conversations.ask(MEMBER, conversation.id, 'Hi');
    const { messages } = await h.core.conversations.get(MEMBER, conversation.id);

    await expect(
      h.core.savedQuestions.save(MEMBER, { conversationId: conversation.id, answerMessageId: messages[1]!.id }),
    ).rejects.toThrow(ValidationError);
  });

  test('a private Saved Question is invisible to others; a shared one can be browsed and run by everyone', async () => {
    const saved = await h.core.savedQuestions.save(MEMBER, await answered());

    await expect(h.core.savedQuestions.get(OTHER, saved.id)).rejects.toThrow(NotFoundError);
    await expect(h.core.savedQuestions.run(OTHER, saved.id)).rejects.toThrow(NotFoundError);
    expect(await h.core.savedQuestions.list(OTHER, { scope: 'shared' })).toEqual([]);

    await h.core.savedQuestions.update(MEMBER, saved.id, { visibility: 'shared' });

    expect(await h.core.savedQuestions.list(OTHER, { scope: 'shared' })).toMatchObject([{ id: saved.id, ownerSlackUserId: MEMBER, ownerName: MEMBER }]);
    expect(await h.core.savedQuestions.list(OTHER, { scope: 'mine' })).toEqual([]);
    expect((await h.core.savedQuestions.run(OTHER, saved.id)).status).toBe('complete');
  });

  test('only the owner can change a Saved Question; the owner or an admin can delete it', async () => {
    const saved = await h.core.savedQuestions.save(MEMBER, { ...(await answered()), visibility: 'shared' });

    await expect(h.core.savedQuestions.update(OTHER, saved.id, { visibility: 'private' })).rejects.toThrow(ForbiddenError);
    await expect(h.core.savedQuestions.delete(OTHER, saved.id)).rejects.toThrow(ForbiddenError);
    expect(await h.core.savedQuestions.update(MEMBER, saved.id, { title: 'Renamed' })).toMatchObject({ title: 'Renamed' });

    await h.core.savedQuestions.delete(ADMIN, saved.id);

    await expect(h.core.savedQuestions.get(MEMBER, saved.id)).rejects.toThrow(NotFoundError);
  });

  test('a Pinned Query broken by a schema change makes the re-run fail visibly', async () => {
    const saved = await h.core.savedQuestions.save(MEMBER, await answered());
    await pgDb.sql('DROP TABLE orders');

    const run = await h.core.savedQuestions.run(MEMBER, saved.id);

    expect(run.status).toBe('failed');
    expect(run.error).toContain('"totals" failed');
    expect(run.blocks).toMatchObject([{ status: 'error' }]);
  });
});
