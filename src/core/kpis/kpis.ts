/**
 * KPIs and KPI Alerts (ADR 0001). A KPI is a named single number defined by a Pinned Query:
 * the agent drafts it from a plain-language Prompt in a Web Conversation the creator can
 * refine, and approving pins the query. A KPI Alert checks a KPI on a schedule against a
 * condition; checks run the Pinned Query without the LLM. An Alert is `armed` until its
 * condition becomes true, then fires once (the LLM writes the Slack message) and stays
 * `fired` until the condition clears, which re-arms it.
 *
 * Same permissions as Reports: everyone sees, edits and pauses them; only admins delete.
 * Mongo collections `kpis` and `kpiAlerts`; checks are scheduled through the `kpiAlert` job kind.
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { generateText } from 'ai';
import { BIBOT_ACTOR, queryEntries, tokenEntries, type AuditRecorder } from '../audit/audit';
import type { Db } from 'mongodb';
import type { AskOptions, Conversations } from '../conversations/conversations';
import { NotFoundError, ValidationError } from '../errors';
import type { ActiveLanguageModel } from '../llm-settings/llm-settings';
import type { PinnedAnswer, PinnedQueries, PinnedRun } from '../pinned-queries/pinned-queries';
import type { Clock, SlackGateway } from '../ports';
import { destinationChannel, resolveDestination, type ReportDestination, type ReportDestinationInput } from '../reports/destination';
import { approvableAnswer } from '../reports/reports';
import { nextRunAt, validateSchedule, type ReportSchedule } from '../reports/schedule';
import type { Jobs } from '../scheduler/scheduler';
import { toMrkdwn } from '../slack/render';
import type { Users } from '../users/users';
import { conditionMet, describeCondition, formatNumber, validateCondition, type KpiAlertCondition } from './condition';
import { KPI_NAME_MAX } from './kpi-options';

/** `draft` until a person approves its query; `paused` keeps the query but its Alerts don't check. */
export type KpiStatus = 'draft' | 'active' | 'paused';

/** A KPI's number as last measured. */
export interface KpiValue {
  value: number;
  at: Date;
}

export interface Kpi {
  id: string;
  name: string;
  /** The plain-language definition the agent drafted the query from. */
  prompt: string;
  status: KpiStatus;
  /** The Web Conversation the agent drafted the query in. */
  conversationId: string;
  /** Null until approved. */
  pinned: PinnedAnswer | null;
  /** Null until approved. */
  value: KpiValue | null;
  createdBy: string;
  createdByName: string;
  createdAt: Date;
  updatedAt: Date;
  approvedBy: string | null;
  approvedAt: Date | null;
}

/** `paused` Alerts don't check. */
export type KpiAlertStatus = 'active' | 'paused';

/** `armed` until its condition becomes true; `fired` from then until it clears. */
export type KpiAlertState = 'armed' | 'fired';

export interface KpiAlert {
  id: string;
  kpiId: string;
  name: string;
  condition: KpiAlertCondition;
  /** How often it checks, read in `timezone`. */
  schedule: ReportSchedule;
  timezone: string;
  destination: ReportDestination;
  status: KpiAlertStatus;
  state: KpiAlertState;
  /** The KPI's value at the last successful check; a % change compares with it. */
  lastValue: number | null;
  lastCheckedAt: Date | null;
  /** When it last fired. */
  firedAt: Date | null;
  /** Why the last check failed; null after a successful one. */
  lastError: string | null;
  /** Null unless active. */
  nextCheckAt: Date | null;
  createdBy: string;
  createdByName: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface KpiAlertInput {
  /** Default: the KPI's name and the condition, e.g. "Daily orders below 100". */
  name?: string;
  condition: KpiAlertCondition;
  schedule: ReportSchedule;
  timezone: string;
  destination: ReportDestinationInput;
}

export interface Kpis {
  /** Asks the agent the Prompt in a new Web Conversation and stores a draft KPI pointing at it. */
  createFromPrompt(
    actorSlackUserId: string,
    input: { prompt: string; name?: string },
    options?: AskOptions,
  ): Promise<Kpi>;
  get(actorSlackUserId: string, id: string): Promise<Kpi>;
  /** Every KPI, most recently updated first. */
  list(actorSlackUserId: string): Promise<Kpi[]>;
  /**
   * Pins the latest complete Answer of the draft's Conversation, after checking it gives a single
   * number (ValidationError otherwise, or when the KPI is not a draft). The actor must be a
   * Participant of the Conversation (NotFoundError).
   */
  approve(actorSlackUserId: string, id: string): Promise<Kpi>;
  /** Anyone: runs the Pinned Query now (no LLM) and stores the value. ValidationError if it fails or is a draft. */
  refresh(actorSlackUserId: string, id: string): Promise<Kpi>;
  /** Anyone: renames the KPI (ValidationError when empty). */
  rename(actorSlackUserId: string, id: string, name: string): Promise<Kpi>;
  /** Anyone: its Alerts skip their checks while it is paused (ValidationError unless active). */
  pause(actorSlackUserId: string, id: string): Promise<Kpi>;
  /** Anyone: its Alerts check again (ValidationError unless paused). */
  resume(actorSlackUserId: string, id: string): Promise<Kpi>;
  /** Admin only (ForbiddenError). Deletes the KPI and its Alerts. */
  remove(actorSlackUserId: string, id: string): Promise<void>;

  /**
   * An armed Alert on an approved KPI (ValidationError for a draft), checked from the next
   * scheduled time on. Settings are checked like a Report's (ValidationError with field errors).
   */
  createAlert(actorSlackUserId: string, input: KpiAlertInput & { kpiId: string }): Promise<KpiAlert>;
  getAlert(actorSlackUserId: string, id: string): Promise<KpiAlert>;
  /** Alerts on one KPI, or every Alert; most recently updated first. */
  listAlerts(actorSlackUserId: string, kpiId?: string): Promise<KpiAlert[]>;
  /**
   * Anyone: changes the name, condition, frequency and destination, checked as when creating.
   * A DM goes to the Alert's creator. A new condition re-arms it; an active Alert is rescheduled.
   */
  updateAlert(actorSlackUserId: string, id: string, input: KpiAlertInput): Promise<KpiAlert>;
  /** Anyone: stops an active Alert from checking (ValidationError unless active). */
  pauseAlert(actorSlackUserId: string, id: string): Promise<KpiAlert>;
  /** Anyone: checks a paused Alert again from the next scheduled time (ValidationError unless paused). */
  resumeAlert(actorSlackUserId: string, id: string): Promise<KpiAlert>;
  /** Admin only (ForbiddenError). */
  removeAlert(actorSlackUserId: string, id: string): Promise<void>;
}

type KpiDoc = Omit<Kpi, 'id'> & { _id: string };
type KpiAlertDoc = Omit<KpiAlert, 'id'> & { _id: string };

interface Deps {
  db: Db;
  clock: Clock;
  users: Users;
  conversations: Conversations;
  pinnedQueries: PinnedQueries;
  slack: SlackGateway;
  llm: ActiveLanguageModel;
  jobs: Jobs;
  /** The web app's URL; Alert messages link to the KPI there. */
  appUrl?: string;
  onError?: (error: unknown) => void;
  audit: AuditRecorder;
}

export { KPI_NAME_MAX };
export const KPI_ALERT_JOB = 'kpiAlert';

/** Currently firing: the condition held at the last check, and the Alert is still checking (not paused). */
export function isFiring(alert: Pick<KpiAlert, 'status' | 'state'>): boolean {
  return alert.status === 'active' && alert.state === 'fired';
}

export function kpiPath(kpiId: string): string {
  return `/kpis/${kpiId}`;
}

export function createKpis(deps: Deps): Kpis {
  const { db, clock, users, conversations, pinnedQueries, slack, jobs, audit } = deps;
  const kpis = db.collection<KpiDoc>('kpis');
  const alerts = db.collection<KpiAlertDoc>('kpiAlerts');

  async function load(id: string): Promise<KpiDoc> {
    const doc = await kpis.findOne({ _id: id });
    if (!doc) throw new NotFoundError('KPI not found.');
    return doc;
  }

  async function loadAlert(id: string): Promise<KpiAlertDoc> {
    const doc = await alerts.findOne({ _id: id });
    if (!doc) throw new NotFoundError('KPI Alert not found.');
    return doc;
  }

  async function audited(
    actor: string,
    type: 'kpi' | 'kpi_alert',
    action: string,
    target: { id: string; name: string },
    details?: Record<string, unknown>,
  ) {
    await audit.record({ actor, type, action, target: { id: target.id, name: target.name }, details });
  }

  /** Runs the Pinned Queries and records them in the audit log as run by `actor`. */
  async function runPinned(actor: string, kpiId: string, pinned: PinnedAnswer) {
    const run = await pinnedQueries.run(pinned);
    await audit.record(...queryEntries(actor, run.queries, { kind: 'kpi', id: kpiId }));
    return run;
  }

  /** Applies `fields` if the KPI is still in `status` (it may have changed since it was read). */
  async function setKpiIfStatus(id: string, status: KpiStatus, fields: Partial<KpiDoc>): Promise<Kpi> {
    const updated = await kpis.findOneAndUpdate({ _id: id, status }, { $set: fields }, { returnDocument: 'after' });
    if (!updated) throw new ValidationError('The KPI changed meanwhile. Reload and try again.');
    return toKpi(updated);
  }

  /** Applies `fields` if the Alert is still `status`. */
  async function setAlertIfStatus(id: string, status: KpiAlertStatus, fields: Partial<KpiAlertDoc>): Promise<KpiAlert> {
    const updated = await alerts.findOneAndUpdate({ _id: id, status }, { $set: fields }, { returnDocument: 'after' });
    if (!updated) throw new ValidationError('The KPI Alert changed meanwhile. Reload and try again.');
    return toAlert(updated);
  }

  /** Validates name, condition, schedule, timezone and destination; a DM goes to `dmTo`. */
  async function alertSettingsOf(dmTo: string, input: KpiAlertInput, kpi: KpiDoc) {
    const fieldErrors: Record<string, string> = {};
    let scheduled: ReturnType<typeof validateSchedule> | null = null;
    try {
      scheduled = validateSchedule(input.schedule, input.timezone);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      Object.assign(fieldErrors, error.fieldErrors);
    }
    const condition = validateCondition(input.condition);
    if (!condition.ok) fieldErrors.condition = condition.error;
    const destination = await resolveDestination(slack, dmTo, input.destination);
    if (!destination.ok) fieldErrors.destination = destination.error;
    if (Object.keys(fieldErrors).length > 0 || !scheduled || !condition.ok || !destination.ok) {
      throw new ValidationError(fieldErrors.destination ?? 'Check the KPI Alert settings.', fieldErrors);
    }
    const name = shorten(input.name?.trim() || `${kpi.name} ${describeCondition(condition.condition)}`);
    return { name, condition: condition.condition, ...scheduled, destination: destination.destination };
  }

  /** A Slack link on its own line to a page of the web app; empty without an app URL. */
  function slackLink(path: string, label: string): string {
    return deps.appUrl ? `\n<${deps.appUrl.replace(/\/+$/, '')}${path}|${label}>` : '';
  }

  async function post(alert: KpiAlertDoc, text: string) {
    try {
      await slack.postMessage({ channel: destinationChannel(alert.destination), text });
      return true;
    } catch (error) {
      deps.onError?.(error);
      return false;
    }
  }

  /** Runs the KPI's Pinned Query (never the LLM) and stores the number as the KPI's value. */
  async function measure(actor: string, kpi: KpiDoc & { pinned: PinnedAnswer }): Promise<ReturnType<typeof kpiNumber>> {
    const measured = kpiNumber(kpi.pinned, await runPinned(actor, kpi._id, kpi.pinned));
    if (measured.ok) await kpis.updateOne({ _id: kpi._id }, { $set: { value: { value: measured.value, at: clock.now() } } });
    return measured;
  }

  /** The LLM writes the message; a plain one stands in when it is unavailable. */
  async function firedMessage(alert: KpiAlertDoc, kpi: KpiDoc, value: number, previous: number | null): Promise<string> {
    const facts =
      `KPI: ${kpi.name} (${kpi.prompt})\nAlert condition: ${describeCondition(alert.condition)}\n` +
      `Current value: ${formatNumber(value)}\nPrevious value: ${previous === null ? 'none' : formatNumber(previous)}`;
    try {
      const { text, usage } = await generateText({
        model: await deps.llm.getModel(),
        system:
          'You write a Slack alert for a business KPI that just met its alert condition. In one or two short sentences, ' +
          'say what happened: the current value, the threshold or change that triggered it, and the previous value. ' +
          'Use only the numbers given; never invent figures. Plain markdown, no headings.',
        prompt: facts,
      });
      await audit.record(
        ...tokenEntries(BIBOT_ACTOR, usage, await deps.llm.choice(), 'alert_message', { kind: 'kpi_alert', id: alert._id }),
      );
      if (text.trim()) return text.trim();
    } catch (error) {
      deps.onError?.(error);
    }
    const was = previous === null ? '' : ` (was ${formatNumber(previous)})`;
    return `${kpi.name} is ${formatNumber(value)}${was}: ${describeCondition(alert.condition)}.`;
  }

  /** The scheduler's handler: one check, then when the next is due. Only firing asks the LLM. */
  async function checkAlert(alertId: string): Promise<Date | null> {
    const alert = await alerts.findOne({ _id: alertId });
    if (alert?.status !== 'active') return null;
    const kpi = await kpis.findOne({ _id: alert.kpiId });
    if (!kpi) return null;
    // Re-read: the Alert may have been paused, edited or deleted while it checked.
    const next = async () => {
      const current = await alerts.findOne({ _id: alertId, status: 'active' });
      if (!current) return null;
      const nextCheckAt = nextRunAt(current.schedule, current.timezone, clock.now());
      await alerts.updateOne({ _id: alertId, status: 'active' }, { $set: { nextCheckAt } });
      return nextCheckAt;
    };
    // A paused KPI's Alerts keep their schedule but skip the check.
    if (kpi.status !== 'active' || !kpi.pinned) return next();

    const measured = await measure(BIBOT_ACTOR, { ...kpi, pinned: kpi.pinned });
    const now = clock.now();
    if (!measured.ok) {
      // Said once, when checks start failing, not on every check.
      if (alert.lastError === null) {
        await post(
          alert,
          `:warning: The KPI Alert *${toMrkdwn(alert.name)}* could not check *${toMrkdwn(kpi.name)}*: ${toMrkdwn(measured.error)}` +
            slackLink(kpiPath(kpi._id), 'Open the KPI'),
        );
      }
      await alerts.updateOne({ _id: alertId, status: 'active' }, { $set: { lastError: measured.error, lastCheckedAt: now } });
      return next();
    }

    const { value } = measured;
    const met = conditionMet(alert.condition, value, alert.lastValue);
    const fires = met && alert.state === 'armed';
    const state: KpiAlertState = met ? 'fired' : 'armed';
    // Claim the change of state first, so an overlapping check never fires twice.
    const { modifiedCount } = await alerts.updateOne(
      { _id: alertId, status: 'active', state: alert.state },
      { $set: { state, lastValue: value, lastCheckedAt: now, lastError: null, ...(fires ? { firedAt: now } : {}) } },
    );
    if (fires && modifiedCount > 0) {
      const text = await firedMessage(alert, kpi, value, alert.lastValue);
      const posted = await post(alert, `:rotating_light: *${toMrkdwn(alert.name)}*\n${toMrkdwn(text)}${slackLink(kpiPath(kpi._id), 'Open the KPI')}`);
      // Not delivered: armed again, so the next check that still meets the condition tries again.
      if (!posted) await alerts.updateOne({ _id: alertId, state: 'fired', firedAt: now }, { $set: { state: 'armed', firedAt: alert.firedAt } });
    }
    return next();
  }

  jobs.handle(KPI_ALERT_JOB, checkAlert);

  return {
    async createFromPrompt(actor, input, options) {
      const prompt = input.prompt.trim();
      if (!prompt) throw new ValidationError('Describe the KPI first.', { prompt: 'Required' });
      const name = shorten(input.name?.trim() || prompt);
      const conversation = await conversations.startWeb(actor);
      await conversations.ask(actor, conversation.id, prompt, options);
      const now = clock.now();
      const doc: KpiDoc = {
        _id: randomUUID(),
        name,
        prompt,
        status: 'draft',
        conversationId: conversation.id,
        pinned: null,
        value: null,
        createdBy: actor,
        createdByName: (await users.get(actor))?.name ?? actor,
        createdAt: now,
        updatedAt: now,
        approvedBy: null,
        approvedAt: null,
      };
      await kpis.insertOne(doc);
      await audited(actor, 'kpi', 'created', { id: doc._id, name: doc.name });
      return toKpi(doc);
    },

    async get(_actor, id) {
      return toKpi(await load(id));
    },

    async list() {
      return (await kpis.find({}).sort({ updatedAt: -1 }).toArray()).map(toKpi);
    },

    async approve(actor, id) {
      const doc = await load(id);
      if (doc.status !== 'draft') throw new ValidationError('Only a draft KPI can be approved.');
      const { messages } = await conversations.get(actor, doc.conversationId);
      const answer = approvableAnswer(messages);
      if (!answer) throw new ValidationError('The agent has no complete Answer to approve yet.');
      const pinned = pinnedQueries.pin(answer.answer);
      const measured = kpiNumber(pinned, await runPinned(actor, id, pinned));
      if (!measured.ok) throw new ValidationError(measured.error);
      const now = clock.now();
      const approved = await setKpiIfStatus(id, 'draft', {
        status: 'active',
        pinned,
        value: { value: measured.value, at: now },
        approvedBy: actor,
        approvedAt: now,
        updatedAt: now,
      });
      await audited(actor, 'kpi', 'approved', approved);
      return approved;
    },

    async refresh(actor, id) {
      const doc = await load(id);
      if (!doc.pinned) throw new ValidationError('Approve the KPI before refreshing it.');
      const measured = await measure(actor, { ...doc, pinned: doc.pinned });
      if (!measured.ok) throw new ValidationError(measured.error);
      return toKpi(await load(id));
    },

    async rename(actor, id, name) {
      const doc = await load(id);
      const trimmed = shorten(name);
      if (!trimmed) throw new ValidationError('Give the KPI a name.', { name: 'Required' });
      const renamed = await setKpiIfStatus(id, doc.status, { name: trimmed, updatedAt: clock.now() });
      await audited(actor, 'kpi', 'renamed', renamed, { previousName: doc.name });
      return renamed;
    },

    async pause(actor, id) {
      const doc = await load(id);
      if (doc.status !== 'active') throw new ValidationError('Only an active KPI can be paused.');
      const paused = await setKpiIfStatus(id, 'active', { status: 'paused', updatedAt: clock.now() });
      await audited(actor, 'kpi', 'paused', paused);
      return paused;
    },

    async resume(actor, id) {
      const doc = await load(id);
      if (doc.status !== 'paused') throw new ValidationError('Only a paused KPI can be resumed.');
      const resumed = await setKpiIfStatus(id, 'paused', { status: 'active', updatedAt: clock.now() });
      await audited(actor, 'kpi', 'resumed', resumed);
      return resumed;
    },

    async remove(actor, id) {
      await users.requireAdmin(actor);
      const owned = await alerts.find({ kpiId: id }, { projection: { _id: 1 } }).toArray();
      const removed = await kpis.findOneAndDelete({ _id: id });
      await alerts.deleteMany({ kpiId: id });
      for (const { _id } of owned) await jobs.set(KPI_ALERT_JOB, _id, null);
      if (removed) await audited(actor, 'kpi', 'deleted', { id, name: removed.name }, { alertsDeleted: owned.length });
    },

    async createAlert(actor, input) {
      const kpi = await load(input.kpiId);
      if (!kpi.pinned) throw new ValidationError('Approve the KPI before adding Alerts to it.');
      const settings = await alertSettingsOf(actor, input, kpi);
      const now = clock.now();
      const nextCheckAt = nextRunAt(settings.schedule, settings.timezone, now);
      const doc: KpiAlertDoc = {
        _id: randomUUID(),
        kpiId: kpi._id,
        ...settings,
        status: 'active',
        state: 'armed',
        // A % change compares with this Alert's own checks, never an older value of the KPI.
        lastValue: null,
        lastCheckedAt: null,
        firedAt: null,
        lastError: null,
        nextCheckAt,
        createdBy: actor,
        createdByName: (await users.get(actor))?.name ?? actor,
        createdAt: now,
        updatedAt: now,
      };
      await alerts.insertOne(doc);
      await jobs.set(KPI_ALERT_JOB, doc._id, nextCheckAt);
      await audited(actor, 'kpi_alert', 'created', { id: doc._id, name: doc.name }, { kpiId: kpi._id, condition: doc.condition });
      return toAlert(doc);
    },

    async getAlert(_actor, id) {
      return toAlert(await loadAlert(id));
    },

    async listAlerts(_actor, kpiId) {
      return (await alerts.find(kpiId ? { kpiId } : {}).sort({ updatedAt: -1 }).toArray()).map(toAlert);
    },

    async updateAlert(actor, id, input) {
      const doc = await loadAlert(id);
      const settings = await alertSettingsOf(doc.createdBy, input, await load(doc.kpiId));
      const now = clock.now();
      const active = doc.status === 'active';
      const nextCheckAt = active ? nextRunAt(settings.schedule, settings.timezone, now) : null;
      const rearm = isDeepStrictEqual(settings.condition, doc.condition) ? {} : { state: 'armed' as const };
      const updated = await setAlertIfStatus(id, doc.status, { ...settings, ...rearm, nextCheckAt, updatedAt: now });
      if (active) await jobs.set(KPI_ALERT_JOB, id, nextCheckAt);
      await audited(actor, 'kpi_alert', 'updated', updated, {
        kpiId: doc.kpiId,
        condition: settings.condition,
        schedule: settings.schedule,
        timezone: settings.timezone,
        destination: settings.destination,
      });
      return updated;
    },

    async pauseAlert(actor, id) {
      const doc = await loadAlert(id);
      if (doc.status !== 'active') throw new ValidationError('Only an active KPI Alert can be paused.');
      const updated = await setAlertIfStatus(id, 'active', { status: 'paused', nextCheckAt: null, updatedAt: clock.now() });
      await jobs.set(KPI_ALERT_JOB, id, null);
      await audited(actor, 'kpi_alert', 'paused', updated);
      return updated;
    },

    async resumeAlert(actor, id) {
      const doc = await loadAlert(id);
      if (doc.status !== 'paused') throw new ValidationError('Only a paused KPI Alert can be resumed.');
      const now = clock.now();
      const nextCheckAt = nextRunAt(doc.schedule, doc.timezone, now);
      // The value from before the pause is stale: a % change starts again from the next check.
      const updated = await setAlertIfStatus(id, 'paused', { status: 'active', lastValue: null, nextCheckAt, updatedAt: now });
      await jobs.set(KPI_ALERT_JOB, id, nextCheckAt);
      await audited(actor, 'kpi_alert', 'resumed', updated);
      return updated;
    },

    async removeAlert(actor, id) {
      await users.requireAdmin(actor);
      const removed = await alerts.findOneAndDelete({ _id: id });
      await jobs.set(KPI_ALERT_JOB, id, null);
      if (removed) await audited(actor, 'kpi_alert', 'deleted', { id, name: removed.name }, { kpiId: removed.kpiId });
    },
  };
}

/**
 * The single number a KPI's run gives: the first numeric column of the one row its first
 * result has (the result its first table or chart shows, else its first query's).
 */
export function kpiNumber(pinned: PinnedAnswer, run: PinnedRun): { ok: true; value: number } | { ok: false; error: string } {
  if (run.status === 'failed') return { ok: false, error: run.error ?? 'The Pinned Query failed.' };
  const shown = pinned.layout.find((b) => b.type !== 'text');
  const resultId = shown && 'resultId' in shown ? shown.resultId : pinned.queries[0]?.resultId;
  const result = resultId ? run.results[resultId] : undefined;
  if (!result) return { ok: false, error: 'The KPI query has no result.' };
  if (result.rows.length !== 1) {
    return { ok: false, error: `A KPI must be a single number, but its query returned ${result.rows.length} rows. Ask the agent for one number.` };
  }
  for (const cell of result.rows[0]!) {
    const value = typeof cell === 'number' ? cell : typeof cell === 'string' && cell.trim() !== '' ? Number(cell) : NaN;
    if (Number.isFinite(value)) return { ok: true, value };
  }
  return { ok: false, error: 'A KPI must be a single number, but its query returned no number. Ask the agent for one number.' };
}

function shorten(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= KPI_NAME_MAX ? oneLine : `${oneLine.slice(0, KPI_NAME_MAX - 1)}…`;
}

function toKpi(doc: KpiDoc): Kpi {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

function toAlert(doc: KpiAlertDoc): KpiAlert {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

/** Names of the draft KPIs made from this Conversation: approving them pins its latest Answer. */
export async function draftKpisMadeFrom(db: Db, conversationId: string): Promise<string[]> {
  const docs = await db
    .collection<KpiDoc>('kpis')
    .find({ status: 'draft', conversationId }, { projection: { name: 1 } })
    .toArray();
  return docs.map((d) => d.name);
}

export async function ensureKpiIndexes(db: Db) {
  await db.collection('kpis').createIndex({ updatedAt: -1 });
  await db.collection('kpiAlerts').createIndex({ kpiId: 1, updatedAt: -1 });
}
