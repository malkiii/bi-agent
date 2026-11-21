import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestHarness, type TestHarness } from '@/core/testing';
import { BIBOT_ACTOR, ForbiddenError, NotFoundError, type AuditEventType, type AuditFilter } from '@/core';
import { CONTRACT_FIXTURE_SQL, createPostgresTestDatabase, type PostgresTestDatabase } from '@/drivers/postgres/testing';

const ADMIN = 'UADMIN';
const MEMBER = 'UMEMBER';

const TOTAL_SQL = 'SELECT sum(amount) AS total FROM orders';

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

/** The agent answers with one query and a table of its result. */
function scriptAnswer() {
  h.llm.script(
    { toolCalls: [{ toolName: 'runQuery', input: { dataSourceId: warehouseId, query: TOTAL_SQL, name: 'value' } }] },
    { toolCalls: [{ toolName: 'emitTable', input: { resultId: 'value' } }] },
    { text: '' },
  );
}

async function entries(filter: AuditFilter = {}) {
  return (await h.core.audit.list(ADMIN, { pageSize: 200, ...filter })).entries;
}

describe('the audit log', () => {
  test('a role change is recorded with who made it and when', async () => {
    await h.core.users.setRole(ADMIN, MEMBER, 'admin');

    expect(await entries({ type: 'role' })).toMatchObject([
      { type: 'role', action: 'changed', actor: ADMIN, at: h.clock.now(), target: { id: MEMBER }, details: { role: 'admin' } },
    ]);
  });

  test('members cannot read it', async () => {
    await expect(h.core.audit.list(MEMBER)).rejects.toThrow(ForbiddenError);
  });
});

describe('usage', () => {
  test('a Prompt records the Prompt, each query it ran and the tokens it used', async () => {
    const conversation = await h.core.conversations.startWeb(MEMBER);
    scriptAnswer();

    await h.core.conversations.ask(MEMBER, conversation.id, 'Total sales?');

    expect(await entries({ actor: MEMBER })).toEqual(
      [
        expect.objectContaining({
          type: 'prompt',
          action: 'asked',
          target: { id: conversation.id },
          details: expect.objectContaining({ prompt: 'Total sales?', source: 'web' }),
        }),
        expect.objectContaining({
          type: 'query',
          action: 'executed',
          details: expect.objectContaining({
            dataSourceId: warehouseId,
            dataSourceName: 'Warehouse',
            query: TOTAL_SQL,
            ok: true,
            rowCount: 1,
            durationMs: expect.any(Number),
          }),
        }),
        expect.objectContaining({
          type: 'tokens',
          action: 'used',
          details: expect.objectContaining({
            purpose: 'answer',
            provider: 'mock',
            model: 'mock-model',
            inputTokens: expect.any(Number),
            outputTokens: expect.any(Number),
          }),
        }),
      ].reverse(),
    );
  });
});

/** `action` per entry of `type`, oldest first. */
async function actions(type: AuditEventType, actor?: string) {
  return (await entries({ type, actor })).map((e) => e.action).reverse();
}

describe('configuration changes', () => {
  test('Data Source and Dataset changes are recorded with the admin who made them', async () => {
    await h.core.dataSources.updateDatasetDetails(ADMIN, warehouseId, 'public.orders', {
      description: 'Orders',
      synonyms: [],
      columns: {},
    });
    await h.core.dataSources.delete(ADMIN, warehouseId);

    expect(await actions('data_source', ADMIN)).toEqual(['created', 'schema_refreshed', 'deleted']);
    expect((await entries({ type: 'dataset' })).reverse()).toMatchObject([
      {
        action: 'exposure_changed',
        actor: ADMIN,
        target: { id: warehouseId, name: 'Warehouse' },
        details: { exposedDatasetIds: ['public.orders'] },
      },
      { action: 'details_updated', actor: ADMIN, target: { id: 'public.orders' }, details: { dataSourceId: warehouseId } },
    ]);
  });

  test('Channel Defaults and LLM settings changes are recorded', async () => {
    h.slack.botChannels.add('CFIN');
    await h.core.channelDefaults.set(ADMIN, 'CFIN', [warehouseId]);
    await h.core.channelDefaults.remove(ADMIN, 'CFIN');
    await h.core.llmSettings.set(ADMIN, { provider: 'mock', model: 'other-model' });

    expect(await actions('channel_default', ADMIN)).toEqual(['set', 'removed']);
    expect(await entries({ type: 'llm_settings' })).toMatchObject([
      { action: 'changed', actor: ADMIN, details: { provider: 'mock', model: 'other-model' } },
    ]);
  });
});

describe('scheduled work', () => {
  const WEEKLY = { schedule: { kind: 'weekly', weekday: 1, time: '09:00' }, timezone: 'UTC' } as const;
  const CHANNEL = 'CREPORTS';

  test('Report changes are recorded; its runs record their queries and commentary tokens as BIBot', async () => {
    h.slack.botChannels.add(CHANNEL);
    scriptAnswer();
    const draft = await h.core.reports.createFromPrompt(MEMBER, {
      prompt: 'Total sales',
      ...WEEKLY,
      destination: { kind: 'channel', channel: CHANNEL },
    });
    await h.core.reports.approve(MEMBER, draft.id);
    await h.core.reports.update(MEMBER, draft.id, {
      title: 'Sales',
      ...WEEKLY,
      destination: { kind: 'channel', channel: CHANNEL },
    });
    await h.core.reports.pause(MEMBER, draft.id);
    await h.core.reports.resume(MEMBER, draft.id);

    h.llm.script({ text: 'Sales are steady.' });
    h.clock.set(new Date('2026-01-12T09:00:00Z'));
    expect(await h.core.scheduler.runDue()).toBe(1);
    await h.core.reports.remove(ADMIN, draft.id);

    expect(await actions('report')).toEqual(['created', 'approved', 'updated', 'paused', 'resumed', 'deleted']);
    expect((await entries({ type: 'report' })).at(-1)).toMatchObject({
      actor: MEMBER,
      target: { id: draft.id },
    });
    const bibot = await entries({ actor: BIBOT_ACTOR });
    expect(bibot.map((e) => e.type).sort()).toEqual(['query', 'tokens']);
    expect(bibot).toContainEqual(
      expect.objectContaining({ type: 'tokens', details: expect.objectContaining({ purpose: 'report_commentary' }) }),
    );
  });

  test('KPI and KPI Alert changes are recorded', async () => {
    scriptAnswer();
    const draft = await h.core.kpis.createFromPrompt(MEMBER, { prompt: 'Total sales' });
    const kpi = await h.core.kpis.approve(MEMBER, draft.id);
    await h.core.kpis.rename(MEMBER, kpi.id, 'Sales');
    await h.core.kpis.pause(MEMBER, kpi.id);
    await h.core.kpis.resume(MEMBER, kpi.id);
    h.slack.botChannels.add(CHANNEL);
    const settings = {
      condition: { kind: 'above', value: 40 },
      ...WEEKLY,
      destination: { kind: 'channel', channel: CHANNEL },
    } as const;
    const alert = await h.core.kpis.createAlert(MEMBER, { kpiId: kpi.id, ...settings });
    await h.core.kpis.updateAlert(MEMBER, alert.id, { ...settings, name: 'Big sales' });
    await h.core.kpis.pauseAlert(MEMBER, alert.id);
    await h.core.kpis.resumeAlert(MEMBER, alert.id);
    await h.core.kpis.removeAlert(ADMIN, alert.id);
    await h.core.kpis.remove(ADMIN, kpi.id);

    expect(await actions('kpi')).toEqual(['created', 'approved', 'renamed', 'paused', 'resumed', 'deleted']);
    expect(await actions('kpi_alert')).toEqual(['created', 'updated', 'paused', 'resumed', 'deleted']);
    expect((await entries({ type: 'kpi_alert' }))[0]).toMatchObject({
      actor: ADMIN,
      target: { id: alert.id, name: 'Big sales' },
    });
  });
});

describe('admin cleanup', () => {
  test('an admin deletes a Conversation with its messages; members cannot', async () => {
    const conversation = await h.core.conversations.startWeb(MEMBER);
    scriptAnswer();
    await h.core.conversations.ask(MEMBER, conversation.id, 'Total sales?');

    await expect(h.core.conversations.remove(MEMBER, conversation.id)).rejects.toThrow(ForbiddenError);
    await h.core.conversations.remove(ADMIN, conversation.id);

    await expect(h.core.conversations.get(MEMBER, conversation.id)).rejects.toThrow(NotFoundError);
    expect(await h.core.conversations.list(MEMBER)).toEqual([]);
    await expect(h.core.conversations.remove(ADMIN, conversation.id)).rejects.toThrow(NotFoundError);
    expect(await entries({ type: 'conversation' })).toMatchObject([
      { action: 'deleted', actor: ADMIN, target: { id: conversation.id, name: 'Total sales?' } },
    ]);
  });

  test('a Conversation a Report or draft KPI was made from cannot be deleted until they are', async () => {
    const CHANNEL = 'CREPORTS';
    h.slack.botChannels.add(CHANNEL);
    scriptAnswer();
    const report = await h.core.reports.createFromPrompt(MEMBER, {
      prompt: 'Total sales',
      schedule: { kind: 'daily', time: '09:00' },
      timezone: 'UTC',
      destination: { kind: 'channel', channel: CHANNEL },
    });
    const reportConversation = (report.origin as { conversationId: string }).conversationId;
    scriptAnswer();
    const kpi = await h.core.kpis.createFromPrompt(MEMBER, { prompt: 'Total sales' });

    // Approving (and re-approving after a failed run) pins from the Conversation again.
    await h.core.reports.approve(MEMBER, report.id);
    await expect(h.core.conversations.remove(ADMIN, reportConversation)).rejects.toThrow(/Report "Total sales"/);
    await expect(h.core.conversations.remove(ADMIN, kpi.conversationId)).rejects.toThrow(/KPI "Total sales"/);

    await h.core.reports.remove(ADMIN, report.id);
    await h.core.kpis.approve(MEMBER, kpi.id); // An approved KPI never pins again.
    await h.core.conversations.remove(ADMIN, reportConversation);
    await h.core.conversations.remove(ADMIN, kpi.conversationId);
    expect(await h.core.conversations.list(MEMBER)).toEqual([]);
  });

  test("admins list everyone's Conversations to clean them up; members cannot", async () => {
    const conversation = await h.core.conversations.startWeb(MEMBER);
    scriptAnswer();
    await h.core.conversations.ask(MEMBER, conversation.id, 'Total sales?');
    await h.core.conversations.startWeb(MEMBER); // Empty: nothing to clean up.

    expect(await h.core.conversations.listAll(ADMIN)).toMatchObject({
      conversations: [{ id: conversation.id, title: 'Total sales?', participants: [MEMBER] }],
      page: 1,
      hasNextPage: false,
    });
    await expect(h.core.conversations.listAll(MEMBER)).rejects.toThrow(ForbiddenError);
  });

  test('an admin deletes a Report Run; members cannot', async () => {
    const CHANNEL = 'CREPORTS';
    h.slack.botChannels.add(CHANNEL);
    scriptAnswer();
    const report = await h.core.reports.createFromPrompt(MEMBER, {
      prompt: 'Total sales',
      schedule: { kind: 'daily', time: '09:00' },
      timezone: 'UTC',
      destination: { kind: 'channel', channel: CHANNEL },
    });
    await h.core.reports.approve(MEMBER, report.id);
    h.llm.script({ text: 'Steady.' });
    h.clock.set(new Date('2026-01-06T09:00:00Z'));
    await h.core.scheduler.runDue();
    const [run] = await h.core.reports.listRuns(MEMBER, report.id);

    await expect(h.core.reports.removeRun(MEMBER, run!.id)).rejects.toThrow(ForbiddenError);
    await h.core.reports.removeRun(ADMIN, run!.id);

    await expect(h.core.reports.getRun(MEMBER, run!.id)).rejects.toThrow(NotFoundError);
    expect(await h.core.reports.listRuns(MEMBER, report.id)).toEqual([]);
    expect(await entries({ type: 'report_run' })).toMatchObject([
      { action: 'deleted', actor: ADMIN, target: { id: run!.id }, details: { reportId: report.id } },
    ]);
  });

  test('uploading and deleting an uploaded Dataset are recorded', async () => {
    const preview = await h.core.uploads.preview(MEMBER, { filename: 'sales.csv', content: new TextEncoder().encode('a\n1\n') });
    await h.core.uploads.confirm(MEMBER, {
      uploadId: preview.uploadId,
      sheets: [{ sheet: preview.sheets[0]!.sheet, datasetName: 'sales', mode: 'new' }],
    });
    await h.core.uploads.delete(ADMIN, 'sales');

    const uploads = (await entries({ type: 'dataset' })).filter((e) => e.target?.id === 'sales');
    expect(uploads.reverse()).toMatchObject([
      { action: 'uploaded', actor: MEMBER, target: { id: 'sales' }, details: { mode: 'new', rowCount: 1 } },
      { action: 'deleted', actor: ADMIN, target: { id: 'sales' } },
    ]);
  });
});
