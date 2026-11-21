import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestHarness, type TestHarness } from '@/core/testing';
import { ForbiddenError, NotFoundError, ValidationError } from '@/core';
import { CONTRACT_FIXTURE_SQL, createPostgresTestDatabase, type PostgresTestDatabase } from '@/drivers/postgres/testing';

const ADMIN = 'UADMIN';
const MEMBER = 'UMEMBER';
const OTHER = 'UOTHER';
const CHANNEL = 'CALERTS';

/** The fixture's three orders total 37.75. */
const TOTAL_SQL = 'SELECT sum(amount) AS total FROM orders';
/** Every day at 09:00 UTC. */
const DAILY = { schedule: { kind: 'daily', time: '09:00' }, timezone: 'UTC' } as const;

let pgDb: PostgresTestDatabase;
let h: TestHarness;
let warehouseId: string;
beforeEach(async () => {
  pgDb = await createPostgresTestDatabase();
  await pgDb.sql(CONTRACT_FIXTURE_SQL);
  // The harness starts on Monday 2026-01-05 09:00Z.
  h = await createTestHarness({ config: { slackTeamId: 'T1', adminSlackUserIds: [ADMIN], appUrl: 'https://botley.example' } });
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

/** The agent answers with one query and a table of its result. */
function scriptAnswer(query = TOTAL_SQL) {
  h.llm.script(
    { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query, name: 'value' } }] },
    { toolCalls: [{ toolName: 'emitTable', input: { resultId: 'value' } }] },
    { text: '' },
  );
}

async function draftKpi(query = TOTAL_SQL) {
  scriptAnswer(query);
  return h.core.kpis.createFromPrompt(MEMBER, { prompt: 'Total sales' });
}

async function approvedKpi() {
  return h.core.kpis.approve(MEMBER, (await draftKpi()).id);
}

describe('defining a KPI', () => {
  test('the agent drafts a single-number query; approving pins it and shows its current value', async () => {
    const draft = await draftKpi();

    expect(draft).toMatchObject({ name: 'Total sales', prompt: 'Total sales', status: 'draft', pinned: null, value: null, createdBy: MEMBER });
    const { messages } = await h.core.conversations.get(MEMBER, draft.conversationId);
    expect(messages.map((m) => m.kind)).toEqual(['prompt', 'answer']);

    const kpi = await h.core.kpis.approve(MEMBER, draft.id);

    expect(kpi).toMatchObject({
      status: 'active',
      approvedBy: MEMBER,
      pinned: { queries: [{ resultId: 'value', query: TOTAL_SQL }] },
      value: { value: 37.75, at: h.clock.now() },
    });
    expect(await h.core.kpis.list(OTHER)).toMatchObject([{ id: kpi.id, status: 'active' }]);
  });

  test('anyone can refresh a KPI to see its current value, without the LLM', async () => {
    const kpi = await approvedKpi();
    await pgDb.sql("INSERT INTO orders VALUES (4, 'south', 5)");
    h.llm.script();
    h.clock.advance(60_000);

    expect(await h.core.kpis.refresh(OTHER, kpi.id)).toMatchObject({ value: { value: 42.75, at: h.clock.now() } });
    expect(h.llm.model.doGenerateCalls).toHaveLength(0);

    await pgDb.sql('DROP TABLE orders');
    await expect(h.core.kpis.refresh(OTHER, kpi.id)).rejects.toThrow(ValidationError);
  });

  test('an Answer that is not a single number cannot be approved; it stays a draft to refine', async () => {
    const draft = await draftKpi('SELECT region, sum(amount) AS total FROM orders GROUP BY region');

    await expect(h.core.kpis.approve(MEMBER, draft.id)).rejects.toThrow(/single number.*2 rows/);
    expect(await h.core.kpis.get(MEMBER, draft.id)).toMatchObject({ status: 'draft', pinned: null });

    h.llm.script(
      { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query: TOTAL_SQL, name: 'total' } }] },
      { toolCalls: [{ toolName: 'emitTable', input: { resultId: 'total' } }] },
      { text: '' },
    );
    await h.core.conversations.ask(MEMBER, draft.conversationId, 'Just the overall total');

    expect(await h.core.kpis.approve(MEMBER, draft.id)).toMatchObject({ status: 'active', value: { value: 37.75 } });
  });
});

describe('KPI Alerts', () => {
  /** An Alert on total sales above 40, checked daily at 09:00 UTC into the channel. */
  async function alertAbove40() {
    const kpi = await approvedKpi();
    const alert = await h.core.kpis.createAlert(MEMBER, {
      kpiId: kpi.id,
      condition: { kind: 'above', value: 40 },
      ...DAILY,
      destination: { kind: 'channel', channel: CHANNEL },
    });
    return { kpi, alert };
  }

  /** Moves the clock to 09:00 UTC on `day` of January 2026 and runs the due checks. */
  async function checkOn(day: number) {
    h.clock.set(new Date(`2026-01-${String(day).padStart(2, '0')}T09:00:00Z`));
    return h.core.scheduler.runDue();
  }

  test('an Alert has a condition, a check frequency and a destination, and starts armed', async () => {
    const { kpi, alert } = await alertAbove40();

    expect(alert).toMatchObject({
      kpiId: kpi.id,
      name: 'Total sales above 40',
      condition: { kind: 'above', value: 40 },
      schedule: { kind: 'daily', time: '09:00' },
      timezone: 'UTC',
      destination: { kind: 'channel', channel: CHANNEL },
      status: 'active',
      state: 'armed',
      nextCheckAt: new Date('2026-01-06T09:00:00Z'),
    });
    expect(await h.core.kpis.listAlerts(OTHER, kpi.id)).toMatchObject([{ id: alert.id }]);
  });

  test('checks run the Pinned Query without the LLM; it fires once when the condition becomes true and re-arms when it clears', async () => {
    const { kpi, alert } = await alertAbove40();
    // Each `script` gives a fresh mock model, so calls are counted on the current one.
    const llmCalls = () => h.llm.model.doGenerateCalls.length + h.llm.model.doStreamCalls.length;
    h.llm.script();

    // 37.75: not above 40, nothing happens and the LLM is not asked.
    expect(await checkOn(6)).toBe(1);
    expect(h.slack.messages).toEqual([]);
    expect(llmCalls()).toBe(0);
    expect(await h.core.kpis.getAlert(MEMBER, alert.id)).toMatchObject({
      state: 'armed',
      lastValue: 37.75,
      lastCheckedAt: h.clock.now(),
      nextCheckAt: new Date('2026-01-07T09:00:00Z'),
    });

    // 42.75: the condition becomes true, so it fires once with an LLM-written message.
    await pgDb.sql("INSERT INTO orders VALUES (4, 'south', 5)");
    h.llm.script({ text: 'Total sales reached **42.75**, above 40 (was 37.75).' });
    await checkOn(7);
    expect(h.llm.model.doStreamCalls).toHaveLength(0);
    expect(h.llm.model.doGenerateCalls).toHaveLength(1); // only the message
    expect(h.slack.messages).toHaveLength(1);
    expect(h.slack.messages[0]).toMatchObject({ channel: CHANNEL });
    expect(h.slack.messages[0]!.text).toContain('Total sales reached *42.75*, above 40 (was 37.75).');
    expect(h.slack.messages[0]!.text).toContain(`https://botley.example/kpis/${kpi.id}|`);
    const prompt = JSON.stringify(h.llm.model.doGenerateCalls.at(-1)!.prompt);
    for (const fact of ['42.75', '40', '37.75']) expect(prompt).toContain(fact);
    expect(await h.core.kpis.getAlert(MEMBER, alert.id)).toMatchObject({ state: 'fired', firedAt: h.clock.now(), lastValue: 42.75 });
    expect(await h.core.kpis.get(MEMBER, kpi.id)).toMatchObject({ value: { value: 42.75, at: h.clock.now() } });

    // Still above 40: quiet.
    await checkOn(8);
    expect(h.slack.messages).toHaveLength(1);
    expect(llmCalls()).toBe(1);

    // Back to 37.75: the condition clears and it re-arms, quietly.
    await pgDb.sql('DELETE FROM orders WHERE id = 4');
    await checkOn(9);
    expect(h.slack.messages).toHaveLength(1);
    expect(await h.core.kpis.getAlert(MEMBER, alert.id)).toMatchObject({ state: 'armed' });

    // Above again: it fires again.
    await pgDb.sql("INSERT INTO orders VALUES (4, 'south', 5)");
    h.llm.script({ text: 'Above 40 again.' });
    await checkOn(10);
    expect(h.slack.messages).toHaveLength(2);
  });

  test('a % change compares with the previous check', async () => {
    const kpi = await approvedKpi();
    await h.core.kpis.createAlert(MEMBER, {
      kpiId: kpi.id,
      condition: { kind: 'change', direction: 'up', percent: 10 },
      ...DAILY,
      destination: { kind: 'channel', channel: CHANNEL },
    });
    await checkOn(6); // 37.75: the first value to compare with

    // 37.75 -> 42.75 is up 13%: fires.
    await pgDb.sql("INSERT INTO orders VALUES (4, 'south', 5)");
    h.llm.script({ text: 'Up 13%.' });
    await checkOn(7);
    expect(h.slack.messages).toHaveLength(1);

    // 42.75 -> 43.75 is up 2%: clears and re-arms.
    await pgDb.sql("INSERT INTO orders VALUES (5, 'south', 1)");
    await checkOn(8);
    // 43.75 -> 53.75 is up 23%: fires again.
    await pgDb.sql("INSERT INTO orders VALUES (6, 'south', 10)");
    h.llm.script({ text: 'Up 23%.' });
    await checkOn(9);
    expect(h.slack.messages.map((m) => m.text)).toEqual([expect.stringContaining('Up 13%.'), expect.stringContaining('Up 23%.')]);
  });

  test("a % change compares with the Alert's own previous check, so its first check never fires", async () => {
    const kpi = await approvedKpi(); // measured at 37.75 when approved
    await pgDb.sql("INSERT INTO orders VALUES (4, 'south', 50)"); // 87.75 by the first check
    await h.core.kpis.createAlert(MEMBER, {
      kpiId: kpi.id,
      condition: { kind: 'change', direction: 'up', percent: 10 },
      ...DAILY,
      destination: { kind: 'channel', channel: CHANNEL },
    });
    h.llm.script();

    await checkOn(6);

    expect(h.slack.messages).toEqual([]);
  });

  test('an alert Slack could not take is tried again at the next check', async () => {
    const { alert } = await alertAbove40();
    await pgDb.sql("INSERT INTO orders VALUES (4, 'south', 5)");
    h.llm.script({ text: 'Above 40.' }, { text: 'Above 40, again.' });
    h.slack.failPostsTo.add(CHANNEL);

    await checkOn(6);
    expect(await h.core.kpis.getAlert(MEMBER, alert.id)).toMatchObject({ state: 'armed' });

    h.slack.failPostsTo.delete(CHANNEL);
    await checkOn(7);
    expect(h.slack.messages.map((m) => m.text)).toEqual([expect.stringContaining('Above 40, again.')]);
    expect(await h.core.kpis.getAlert(MEMBER, alert.id)).toMatchObject({ state: 'fired' });
  });

  test('a check that fails is said once in Slack, keeps checking, and recovers', async () => {
    const { alert } = await alertAbove40();
    await pgDb.sql('ALTER TABLE orders RENAME TO orders_old');
    h.llm.script();

    await checkOn(6);
    await checkOn(7);

    expect(h.llm.model.doGenerateCalls).toHaveLength(0);
    expect(h.slack.messages).toHaveLength(1);
    expect(h.slack.messages[0]!.text).toContain('could not check');
    expect(await h.core.kpis.getAlert(MEMBER, alert.id)).toMatchObject({ state: 'armed', lastError: expect.stringContaining('failed') });

    await pgDb.sql('ALTER TABLE orders_old RENAME TO orders');
    await checkOn(8);
    expect(await h.core.kpis.getAlert(MEMBER, alert.id)).toMatchObject({ lastError: null, lastValue: 37.75 });
  });

  test('an Alert needs an approved KPI and valid settings', async () => {
    const draft = await draftKpi();
    const settings = { condition: { kind: 'above', value: 40 }, ...DAILY, destination: { kind: 'channel', channel: CHANNEL } } as const;
    await expect(h.core.kpis.createAlert(MEMBER, { kpiId: draft.id, ...settings })).rejects.toThrow(ValidationError);

    const kpi = await h.core.kpis.approve(MEMBER, draft.id);
    const saving = h.core.kpis.createAlert(MEMBER, {
      kpiId: kpi.id,
      condition: { kind: 'change', direction: 'up', percent: 0 },
      schedule: { kind: 'daily', time: '25:00' },
      timezone: 'UTC',
      destination: { kind: 'channel', channel: 'CELSEWHERE' },
    });
    await expect(saving).rejects.toMatchObject({
      fieldErrors: { condition: expect.any(String), time: expect.any(String), destination: expect.stringContaining('/invite @Botley') },
    });
  });
});

describe('maintaining KPIs and KPI Alerts', () => {
  const ALERT = { condition: { kind: 'above', value: 40 }, ...DAILY, destination: { kind: 'channel', channel: CHANNEL } } as const;

  async function kpiWithAlert() {
    const kpi = await approvedKpi();
    const alert = await h.core.kpis.createAlert(MEMBER, { kpiId: kpi.id, ...ALERT });
    await pgDb.sql("INSERT INTO orders VALUES (4, 'south', 5)"); // 42.75: the Alert would fire
    return { kpi, alert };
  }

  async function checkOn(day: number) {
    h.clock.set(new Date(`2026-01-${String(day).padStart(2, '0')}T09:00:00Z`));
    return h.core.scheduler.runDue();
  }

  test('anyone can pause an Alert, which then does not check, and resume it', async () => {
    const { alert } = await kpiWithAlert();

    expect(await h.core.kpis.pauseAlert(OTHER, alert.id)).toMatchObject({ status: 'paused', nextCheckAt: null });
    expect(await checkOn(6)).toBe(0);
    expect(h.slack.messages).toEqual([]);

    expect(await h.core.kpis.resumeAlert(OTHER, alert.id)).toMatchObject({ status: 'active', nextCheckAt: new Date('2026-01-07T09:00:00Z') });
    h.llm.script({ text: 'Above 40.' });
    expect(await checkOn(7)).toBe(1);
    expect(h.slack.messages).toHaveLength(1);
  });

  test('anyone can pause a KPI: its Alerts skip their checks until it is resumed', async () => {
    const { kpi } = await kpiWithAlert();

    expect(await h.core.kpis.pause(OTHER, kpi.id)).toMatchObject({ status: 'paused' });
    await checkOn(6);
    expect(h.slack.messages).toEqual([]);

    await h.core.kpis.resume(OTHER, kpi.id);
    h.llm.script({ text: 'Above 40.' });
    await checkOn(7);
    expect(h.slack.messages).toHaveLength(1);
  });

  test('anyone can rename a KPI and edit an Alert; a new condition re-arms it', async () => {
    const { kpi, alert } = await kpiWithAlert();
    h.llm.script({ text: 'Above 40.' });
    await checkOn(6);
    expect(await h.core.kpis.getAlert(MEMBER, alert.id)).toMatchObject({ state: 'fired' });

    expect(await h.core.kpis.rename(OTHER, kpi.id, 'Revenue')).toMatchObject({ name: 'Revenue' });
    await expect(h.core.kpis.rename(OTHER, kpi.id, '  ')).rejects.toThrow(ValidationError);

    const edited = await h.core.kpis.updateAlert(OTHER, alert.id, {
      name: 'Revenue over 42',
      condition: { kind: 'above', value: 42 },
      schedule: { kind: 'daily', time: '18:00' },
      timezone: 'UTC',
      destination: { kind: 'dm' },
    });
    expect(edited).toMatchObject({
      name: 'Revenue over 42',
      state: 'armed',
      destination: { kind: 'dm', slackUserId: MEMBER }, // a DM goes to the Alert's creator
      nextCheckAt: new Date('2026-01-06T18:00:00Z'),
    });

    h.llm.script({ text: 'Over 42.' });
    h.clock.set(new Date('2026-01-06T18:00:00Z'));
    await h.core.scheduler.runDue();
    expect(h.slack.messages.at(-1)).toMatchObject({ channel: MEMBER });
  });

  test('members cannot delete a KPI or an Alert', async () => {
    const { kpi, alert } = await kpiWithAlert();

    await expect(h.core.kpis.removeAlert(MEMBER, alert.id)).rejects.toThrow(ForbiddenError);
    await expect(h.core.kpis.remove(MEMBER, kpi.id)).rejects.toThrow(ForbiddenError);
    expect(await h.core.kpis.getAlert(MEMBER, alert.id)).toMatchObject({ status: 'active' });
  });

  test('an admin deletes an Alert, or a KPI together with its Alerts; they stop checking', async () => {
    const { kpi, alert } = await kpiWithAlert();
    const other = await h.core.kpis.createAlert(MEMBER, { kpiId: kpi.id, ...ALERT, name: 'Second' });

    await h.core.kpis.removeAlert(ADMIN, alert.id);
    await expect(h.core.kpis.getAlert(MEMBER, alert.id)).rejects.toThrow(NotFoundError);

    await h.core.kpis.remove(ADMIN, kpi.id);
    await expect(h.core.kpis.get(MEMBER, kpi.id)).rejects.toThrow(NotFoundError);
    await expect(h.core.kpis.getAlert(MEMBER, other.id)).rejects.toThrow(NotFoundError);
    expect(await checkOn(6)).toBe(0);
  });
});
