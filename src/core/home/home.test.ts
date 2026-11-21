import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ReportSchedule } from '@/core';
import { createTestHarness, type TestHarness } from '@/core/testing';
import { CONTRACT_FIXTURE_SQL, createPostgresTestDatabase, type PostgresTestDatabase } from '@/drivers/postgres/testing';

const ADMIN = 'UADMIN';
const MEMBER = 'UMEMBER';
const OTHER = 'UOTHER';
const CHANNEL = 'CHOME';

let pgDb: PostgresTestDatabase;
let h: TestHarness;
let warehouseId: string;
beforeEach(async () => {
  pgDb = await createPostgresTestDatabase();
  await pgDb.sql(CONTRACT_FIXTURE_SQL);
  // The harness starts on Monday 2026-01-05 09:00Z.
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
  h.slack.botChannels.add(CHANNEL);
});
afterEach(async () => {
  await h.close();
  await pgDb.drop();
});

/** The agent answers with one query and a table of its result. */
function scriptAnswer(query = 'SELECT sum(amount) AS total FROM orders') {
  h.llm.script(
    { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query, name: 'value' } }] },
    { toolCalls: [{ toolName: 'emitTable', input: { resultId: 'value' } }] },
    { text: '' },
  );
}

async function ask(slackUserId: string, prompt: string) {
  h.llm.script({ text: `About ${prompt}.` });
  const conversation = await h.core.conversations.startWeb(slackUserId);
  await h.core.conversations.ask(slackUserId, conversation.id, prompt);
  h.clock.advance(60_000);
  return conversation.id;
}

describe('the dashboard home', () => {
  test("shows the person's own recent Conversations, newest first", async () => {
    const first = await ask(MEMBER, 'Sales by region');
    await ask(OTHER, 'Not mine');
    const second = await ask(MEMBER, 'Orders this week');

    const home = await h.core.home.overview(MEMBER);

    expect(home.recentConversations.map((c) => c.id)).toEqual([second, first]);
  });

  test('shows the Report Runs coming up, soonest first, with their next run time', async () => {
    async function report(title: string, schedule: ReportSchedule, timezone = 'UTC') {
      scriptAnswer();
      return h.core.reports.createFromPrompt(MEMBER, {
        prompt: title,
        schedule,
        timezone,
        destination: { kind: 'channel', channel: CHANNEL },
      });
    }
    const weekly = await h.core.reports.approve(MEMBER, (await report('Weekly sales', { kind: 'weekly', weekday: 1, time: '09:00' }, 'Europe/Paris')).id);
    const daily = await h.core.reports.approve(MEMBER, (await report('Daily orders', { kind: 'daily', time: '10:00' })).id);
    const paused = await h.core.reports.approve(MEMBER, (await report('Paused', { kind: 'daily', time: '11:00' })).id);
    await h.core.reports.pause(MEMBER, paused.id);
    await report('Still a draft', { kind: 'daily', time: '12:00' });

    const home = await h.core.home.overview(OTHER);

    expect(home.upcomingRuns).toMatchObject([
      { id: daily.id, title: 'Daily orders', nextRunAt: new Date('2026-01-05T10:00:00Z') },
      { id: weekly.id, title: 'Weekly sales', nextRunAt: new Date('2026-01-12T08:00:00Z'), timezone: 'Europe/Paris' },
    ]);
  });

  test('shows the KPI Alerts currently firing, and a tile with the current value of each approved KPI', async () => {
    async function kpi(name: string, query?: string) {
      scriptAnswer(query);
      return h.core.kpis.createFromPrompt(MEMBER, { prompt: name });
    }
    async function alertAbove(kpiId: string, value: number) {
      return h.core.kpis.createAlert(MEMBER, {
        kpiId,
        condition: { kind: 'above', value },
        schedule: { kind: 'daily', time: '09:00' },
        timezone: 'UTC',
        destination: { kind: 'channel', channel: CHANNEL },
      });
    }
    // Total sales are 37.75; there are 3 orders.
    const sales = await h.core.kpis.approve(MEMBER, (await kpi('Total sales')).id);
    h.clock.advance(60_000);
    const orders = await h.core.kpis.approve(MEMBER, (await kpi('Order count', 'SELECT count(*) AS n FROM orders')).id);
    await kpi('Still a draft');
    const firing = await alertAbove(sales.id, 30);
    await alertAbove(sales.id, 100);
    const pausedFiring = await alertAbove(orders.id, 1);
    // The first check: the alerts above 30 and above 1 fire; above 100 stays armed.
    h.llm.script({ text: 'Total sales are above 30.' }, { text: 'Orders are above 1.' });
    h.clock.set(new Date('2026-01-06T09:00:00Z'));
    await h.core.scheduler.runDue();
    // A paused Alert doesn't check, so it isn't currently firing.
    await h.core.kpis.pauseAlert(MEMBER, pausedFiring.id);

    const home = await h.core.home.overview(OTHER);

    expect(home.firingAlerts).toMatchObject([
      { id: firing.id, name: 'Total sales above 30', firedAt: new Date('2026-01-06T09:00:00Z'), kpi: { id: sales.id, name: 'Total sales' } },
    ]);
    expect(home.firingAlerts).toHaveLength(1);
    expect(home.kpis.map((k) => [k.name, k.value?.value])).toEqual([
      ['Order count', 3],
      ['Total sales', 37.75],
    ]);
  });
});
