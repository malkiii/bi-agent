import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestHarness, type TestHarness } from '@/core/testing';
import { ForbiddenError, NotFoundError, ValidationError } from '@/core';
import { CONTRACT_FIXTURE_SQL, createPostgresTestDatabase, type PostgresTestDatabase } from '@/drivers/postgres/testing';

const ADMIN = 'UADMIN';
const MEMBER = 'UMEMBER';
const OTHER = 'UOTHER';
const CHANNEL = 'CREPORTS';

const TOTALS_SQL = 'SELECT region, sum(amount) AS total FROM orders GROUP BY region ORDER BY region';
const BAR_SPEC = {
  mark: 'bar',
  encoding: { x: { field: 'region', type: 'nominal' }, y: { field: 'total', type: 'quantitative' } },
};
/** Mondays at 09:00 Paris time (08:00Z in winter). */
const WEEKLY = { schedule: { kind: 'weekly', weekday: 1, time: '09:00' }, timezone: 'Europe/Paris' } as const;

let pgDb: PostgresTestDatabase;
let h: TestHarness;
let warehouseId: string;
beforeEach(async () => {
  pgDb = await createPostgresTestDatabase();
  await pgDb.sql(CONTRACT_FIXTURE_SQL);
  // The harness starts on Monday 2026-01-05 09:00Z, just after this week's 08:00Z run.
  h = await createTestHarness({ config: { slackTeamId: 'T1', adminSlackUserIds: [ADMIN], appUrl: 'https://bibot.example' } });
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
  h.slack.botChannels.add(CHANNEL);
});
afterEach(async () => {
  await h.close();
  await pgDb.drop();
});

/** The agent answers "Sales by region" with a Table and a Chart of `TOTALS_SQL`. */
function scriptAnswer() {
  h.llm.script(
    { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query: TOTALS_SQL, name: 'totals' } }] },
    {
      toolCalls: [
        { toolName: 'emitTable', input: { resultId: 'totals', title: 'Totals' } },
        { toolName: 'emitChart', input: { resultId: 'totals', title: 'Totals chart', spec: BAR_SPEC } },
      ],
    },
    { text: '' },
  );
}

async function draftFromPrompt() {
  scriptAnswer();
  return h.core.reports.createFromPrompt(MEMBER, {
    prompt: 'Sales by region',
    ...WEEKLY,
    destination: { kind: 'channel', channel: CHANNEL },
  });
}

describe('creating a Report', () => {
  test('from a Prompt: the agent answers once into a draft; approving pins its queries and schedules it', async () => {
    const draft = await draftFromPrompt();

    expect(draft).toMatchObject({
      title: 'Sales by region',
      prompt: 'Sales by region',
      status: 'draft',
      pinned: null,
      nextRunAt: null,
      origin: { kind: 'prompt' },
      createdBy: MEMBER,
    });
    const { messages } = await h.core.conversations.get(MEMBER, (draft.origin as { conversationId: string }).conversationId);
    expect(messages.map((m) => m.kind)).toEqual(['prompt', 'answer']);

    const approved = await h.core.reports.approve(MEMBER, draft.id);

    expect(approved).toMatchObject({
      status: 'active',
      approvedBy: MEMBER,
      pinned: {
        queries: [{ resultId: 'totals', query: TOTALS_SQL }],
        layout: [{ type: 'table', resultId: 'totals' }, { type: 'chart', resultId: 'totals' }],
      },
      nextRunAt: new Date('2026-01-12T08:00:00Z'),
    });
    expect(await h.core.reports.list(OTHER)).toMatchObject([{ id: draft.id, status: 'active' }]);
  });

  test('saving fails clearly when the bot is not in the destination channel, before the agent is asked', async () => {
    scriptAnswer();

    const saving = h.core.reports.createFromPrompt(MEMBER, {
      prompt: 'Sales by region',
      ...WEEKLY,
      destination: { kind: 'channel', channel: 'CELSEWHERE' },
    });

    await expect(saving).rejects.toThrow(ValidationError);
    await expect(saving).rejects.toMatchObject({ fieldErrors: { destination: expect.stringContaining('/invite @BIBot') } });
    expect(h.llm.model.doStreamCalls).toHaveLength(0);
    expect(await h.core.reports.list(MEMBER)).toEqual([]);
  });

  test('a bad schedule is refused with the field that is wrong', async () => {
    const saving = h.core.reports.createFromPrompt(MEMBER, {
      prompt: 'Sales by region',
      schedule: { kind: 'cron', expression: 'every monday' },
      timezone: 'Europe/Paris',
      destination: { kind: 'channel', channel: CHANNEL },
    });

    await expect(saving).rejects.toMatchObject({ fieldErrors: { cron: expect.any(String) } });
  });

  test('approving pins the latest Answer, after the creator refined it in the Conversation', async () => {
    const draft = await draftFromPrompt();
    const conversationId = (draft.origin as { conversationId: string }).conversationId;
    h.llm.script(
      { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query: 'SELECT count(*) AS orders FROM orders', name: 'count' } }] },
      { toolCalls: [{ toolName: 'emitTable', input: { resultId: 'count' } }] },
      { text: '' },
    );
    await h.core.conversations.ask(MEMBER, conversationId, 'Just count the orders');

    const approved = await h.core.reports.approve(MEMBER, draft.id);

    expect(approved.pinned!.queries).toMatchObject([{ resultId: 'count' }]);
  });

  test('only someone who can see the draft Answer can approve it', async () => {
    const draft = await draftFromPrompt();

    await expect(h.core.reports.approve(OTHER, draft.id)).rejects.toThrow(NotFoundError);
    expect(await h.core.reports.get(OTHER, draft.id)).toMatchObject({ status: 'draft' });
  });
});

/** The Report Run id from the link in a posted Slack message. */
function runIdIn(text: string): string {
  const match = /https:\/\/bibot\.example\/reports\/runs\/([\w-]+)\|/.exec(text);
  if (!match) throw new Error(`No Report Run link in: ${text}`);
  return match[1]!;
}

describe('scheduled Report Runs', () => {
  test('a due Report runs its Pinned Queries, gets commentary from the LLM and posts the Report Run URL', async () => {
    const report = await h.core.reports.approve(MEMBER, (await draftFromPrompt()).id);
    await pgDb.sql("INSERT INTO orders VALUES (4, 'south', 5)");
    h.llm.script({ text: 'South caught up with **25**.' });

    h.clock.set(new Date('2026-01-12T07:59:00Z'));
    expect(await h.core.scheduler.runDue()).toBe(0);
    expect(h.slack.messages).toEqual([]);

    h.clock.set(new Date('2026-01-12T08:00:30Z'));
    expect(await h.core.scheduler.runDue()).toBe(1);

    expect(h.llm.model.doStreamCalls).toHaveLength(0); // the agent loop was not run again
    expect(h.llm.model.doGenerateCalls).toHaveLength(1); // only the commentary
    expect(h.slack.messages).toHaveLength(1);
    const [message] = h.slack.messages;
    expect(message).toMatchObject({ channel: CHANNEL });
    expect(message!.threadTs).toBeUndefined();
    expect(message!.text).toContain('*Sales by region*');
    expect(message!.text).toContain('South caught up with *25*.');

    const run = await h.core.reports.getRun(OTHER, runIdIn(message!.text));
    expect(run).toMatchObject({
      reportId: report.id,
      title: 'Sales by region',
      status: 'complete',
      commentary: 'South caught up with **25**.',
      scheduledFor: new Date('2026-01-12T08:00:00Z'),
      timezone: 'Europe/Paris',
      sources: [{ name: 'Warehouse', datasets: ['public.orders'] }],
      blocks: [
        { status: 'ok', block: { type: 'table', title: 'Totals', rows: [['north', 17.75], ['south', 25]] } },
        { status: 'ok', block: { type: 'chart', title: 'Totals chart', data: [{ region: 'north', total: 17.75 }, { region: 'south', total: 25 }] } },
      ],
    });
    expect(await h.core.reports.get(MEMBER, report.id)).toMatchObject({
      lastRunAt: h.clock.now(),
      nextRunAt: new Date('2026-01-19T08:00:00Z'),
    });

    // The Report Run is frozen: later data changes don't touch it.
    await pgDb.sql("INSERT INTO orders VALUES (5, 'north', 100)");
    expect((await h.core.reports.getRun(MEMBER, run.id)).blocks).toEqual(run.blocks);

    // Nothing more runs until the next week.
    h.clock.set(new Date('2026-01-18T23:00:00Z'));
    expect(await h.core.scheduler.runDue()).toBe(0);
  });

  test('a draft is never run', async () => {
    await draftFromPrompt();
    h.clock.set(new Date('2026-02-01T00:00:00Z'));

    expect(await h.core.scheduler.runDue()).toBe(0);
    expect(h.slack.messages).toEqual([]);
  });

  test('a run whose commentary fails still completes and is posted without commentary', async () => {
    await h.core.reports.approve(MEMBER, (await draftFromPrompt()).id);
    h.llm.script(); // every model call fails
    h.clock.set(new Date('2026-01-12T08:00:00Z'));

    await h.core.scheduler.runDue();

    const run = await h.core.reports.getRun(MEMBER, runIdIn(h.slack.messages[0]!.text));
    expect(run).toMatchObject({ status: 'complete', commentary: null });
    expect(run.blocks.every((b) => b.status === 'ok')).toBe(true);
  });

  test('a run whose Pinned Query broke is stored as failed and posted as a failure, without asking for commentary', async () => {
    await h.core.reports.approve(MEMBER, (await draftFromPrompt()).id);
    await pgDb.sql('DROP TABLE orders');
    h.llm.script({ text: 'should not be used' });
    h.clock.set(new Date('2026-01-12T08:00:00Z'));

    await h.core.scheduler.runDue();

    expect(h.llm.model.doGenerateCalls).toHaveLength(0);
    const text = h.slack.messages[0]!.text;
    expect(text).toContain('could not be completed');
    const run = await h.core.reports.getRun(MEMBER, runIdIn(text));
    expect(run).toMatchObject({ status: 'failed', error: expect.stringContaining('"totals" failed'), commentary: null });
  });

  test('a DM Report is posted to its creator', async () => {
    scriptAnswer();
    const draft = await h.core.reports.createFromPrompt(MEMBER, { prompt: 'Sales by region', ...WEEKLY, destination: { kind: 'dm' } });
    expect(draft.destination).toEqual({ kind: 'dm', slackUserId: MEMBER });
    await h.core.reports.approve(MEMBER, draft.id);
    h.llm.script({ text: 'Steady.' });
    h.clock.set(new Date('2026-01-12T08:00:00Z'));

    await h.core.scheduler.runDue();

    expect(h.slack.messages).toMatchObject([{ channel: MEMBER }]);
  });
});

describe('a failed Report Run', () => {
  /** Approves a Report, renames the table its Pinned Query reads, and lets Monday's run fail. */
  async function failOnce() {
    const report = await h.core.reports.approve(MEMBER, (await draftFromPrompt()).id);
    await pgDb.sql('ALTER TABLE orders RENAME TO orders_old');
    h.clock.set(new Date('2026-01-12T08:00:00Z'));
    await h.core.scheduler.runDue();
    return report;
  }

  test('moves the Report to "needs re-approval", stops its schedule and says so in Slack', async () => {
    const report = await failOnce();

    const text = h.slack.messages[0]!.text;
    expect(text).toContain('needs re-approval');
    expect(text).toContain(`https://bibot.example/reports/${report.id}|`);
    expect(await h.core.reports.get(OTHER, report.id)).toMatchObject({
      status: 'needsReapproval',
      nextRunAt: null,
      failure: { runId: runIdIn(text), error: expect.stringContaining('"totals" failed'), at: h.clock.now() },
    });

    h.clock.set(new Date('2026-02-01T00:00:00Z'));
    expect(await h.core.scheduler.runDue()).toBe(0);
    expect(h.slack.messages).toHaveLength(1);
  });

  test('re-approving after the fix resumes the schedule', async () => {
    const report = await failOnce();
    await pgDb.sql('ALTER TABLE orders_old RENAME TO orders');
    h.clock.set(new Date('2026-01-13T10:00:00Z'));

    const reapproved = await h.core.reports.approve(MEMBER, report.id);

    expect(reapproved).toMatchObject({ status: 'active', failure: null, nextRunAt: new Date('2026-01-19T08:00:00Z') });
    h.llm.script({ text: 'Back to normal.' });
    h.clock.set(new Date('2026-01-19T08:00:00Z'));
    expect(await h.core.scheduler.runDue()).toBe(1);
    expect(await h.core.reports.getRun(MEMBER, runIdIn(h.slack.messages[1]!.text))).toMatchObject({ status: 'complete' });
  });
});

describe('maintaining a Report', () => {
  test('anyone can pause a Report, which then does not run, and resume it', async () => {
    const report = await h.core.reports.approve(MEMBER, (await draftFromPrompt()).id);

    expect(await h.core.reports.pause(OTHER, report.id)).toMatchObject({ status: 'paused', nextRunAt: null });
    h.clock.set(new Date('2026-01-20T00:00:00Z'));
    expect(await h.core.scheduler.runDue()).toBe(0);

    const resumed = await h.core.reports.resume(OTHER, report.id);

    expect(resumed).toMatchObject({ status: 'active', nextRunAt: new Date('2026-01-26T08:00:00Z'), pinned: report.pinned });
    h.llm.script({ text: 'Fine.' });
    h.clock.set(new Date('2026-01-26T08:00:00Z'));
    expect(await h.core.scheduler.runDue()).toBe(1);
  });

  test('anyone can edit the title, schedule and destination; the next run follows the new schedule', async () => {
    const report = await h.core.reports.approve(MEMBER, (await draftFromPrompt()).id);
    h.slack.botChannels.add('COTHER');

    const edited = await h.core.reports.update(OTHER, report.id, {
      title: 'Daily sales',
      schedule: { kind: 'daily', time: '18:00' },
      timezone: 'UTC',
      destination: { kind: 'channel', channel: 'COTHER' },
    });

    expect(edited).toMatchObject({
      title: 'Daily sales',
      prompt: 'Sales by region',
      status: 'active',
      schedule: { kind: 'daily', time: '18:00' },
      timezone: 'UTC',
      destination: { kind: 'channel', channel: 'COTHER' },
      nextRunAt: new Date('2026-01-05T18:00:00Z'),
      pinned: report.pinned,
    });
    h.llm.script({ text: 'Fine.' });
    h.clock.set(new Date('2026-01-05T18:00:00Z'));
    expect(await h.core.scheduler.runDue()).toBe(1);
    expect(h.slack.messages).toMatchObject([{ channel: 'COTHER', text: expect.stringContaining('*Daily sales*') }]);
  });

  test('an edit is checked like a new Report, and a DM still goes to the creator', async () => {
    const report = await h.core.reports.approve(MEMBER, (await draftFromPrompt()).id);

    await expect(
      h.core.reports.update(OTHER, report.id, { ...WEEKLY, destination: { kind: 'channel', channel: 'CELSEWHERE' } }),
    ).rejects.toMatchObject({ fieldErrors: { destination: expect.stringContaining('/invite @BIBot') } });

    const edited = await h.core.reports.update(OTHER, report.id, { ...WEEKLY, destination: { kind: 'dm' } });
    expect(edited).toMatchObject({ title: 'Sales by region', destination: { kind: 'dm', slackUserId: MEMBER } });
  });

  test('editing a paused Report keeps it paused', async () => {
    const report = await h.core.reports.approve(MEMBER, (await draftFromPrompt()).id);
    await h.core.reports.pause(MEMBER, report.id);

    const edited = await h.core.reports.update(MEMBER, report.id, { ...WEEKLY, destination: { kind: 'channel', channel: CHANNEL } });

    expect(edited).toMatchObject({ status: 'paused', nextRunAt: null });
    h.clock.set(new Date('2026-02-01T00:00:00Z'));
    expect(await h.core.scheduler.runDue()).toBe(0);
  });

  test('only an active Report can be paused, and only a paused one resumed', async () => {
    const draft = await draftFromPrompt();

    await expect(h.core.reports.pause(MEMBER, draft.id)).rejects.toThrow(ValidationError);
    await expect(h.core.reports.resume(MEMBER, draft.id)).rejects.toThrow(ValidationError);
  });

  test('only a draft or a Report that needs re-approval can be approved', async () => {
    const report = await h.core.reports.approve(MEMBER, (await draftFromPrompt()).id);

    await expect(h.core.reports.approve(MEMBER, report.id)).rejects.toThrow(ValidationError);
    await h.core.reports.pause(MEMBER, report.id);
    await expect(h.core.reports.approve(MEMBER, report.id)).rejects.toThrow(ValidationError);
  });
});

describe('past Report Runs and deleting', () => {
  /** Approves a Report and lets it run on the next two Mondays. */
  async function reportWithTwoRuns() {
    const report = await h.core.reports.approve(MEMBER, (await draftFromPrompt()).id);
    h.llm.script({ text: 'First.' }, { text: 'Second.' });
    h.clock.set(new Date('2026-01-12T08:00:00Z'));
    await h.core.scheduler.runDue();
    h.clock.set(new Date('2026-01-19T08:00:00Z'));
    await h.core.scheduler.runDue();
    return { report, runIds: h.slack.messages.map((m) => runIdIn(m.text)) };
  }

  test('each Report lists its past Report Runs, newest first', async () => {
    const { report, runIds } = await reportWithTwoRuns();
    await draftFromPrompt(); // another Report's runs are not listed

    expect(await h.core.reports.listRuns(OTHER, report.id)).toMatchObject([
      { id: runIds[1], status: 'complete', scheduledFor: new Date('2026-01-19T08:00:00Z') },
      { id: runIds[0], status: 'complete', scheduledFor: new Date('2026-01-12T08:00:00Z') },
    ]);
  });

  test('members cannot delete a Report', async () => {
    const report = await h.core.reports.approve(MEMBER, (await draftFromPrompt()).id);

    await expect(h.core.reports.remove(MEMBER, report.id)).rejects.toThrow(ForbiddenError);
    expect(await h.core.reports.get(MEMBER, report.id)).toMatchObject({ status: 'active' });
  });

  test('an admin deletes a Report: it stops running, and its Report Runs stay open', async () => {
    const { report, runIds } = await reportWithTwoRuns();

    await h.core.reports.remove(ADMIN, report.id);

    await expect(h.core.reports.get(MEMBER, report.id)).rejects.toThrow(NotFoundError);
    expect(await h.core.reports.list(MEMBER)).toEqual([]);
    expect(await h.core.reports.getRun(MEMBER, runIds[0]!)).toMatchObject({ reportId: report.id, status: 'complete' });
    h.clock.set(new Date('2026-03-01T00:00:00Z'));
    expect(await h.core.scheduler.runDue()).toBe(0);
  });
});
