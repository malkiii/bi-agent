/**
 * Reports (ADR 0001): a Prompt run on a schedule. A Report starts as a draft: from a Prompt
 * (the agent answers once, in a Web Conversation the creator can refine) or from a Saved
 * Question. Approving pins the queries and layout and schedules it. Each scheduled run
 * executes the Pinned Queries, asks the LLM only for commentary, stores a frozen Report Run
 * and posts its URL to the destination channel or DM.
 *
 * Reports have no owner: every signed-in user can see them, and every Report Run.
 * Mongo collections `reports` and `reportRuns`; scheduled through the `report` job kind.
 */
import { randomUUID } from 'node:crypto';
import { generateText } from 'ai';
import { BOTLEY_ACTOR, queryEntries, tokenEntries, type AuditRecorder } from '../audit/audit';
import type { Db } from 'mongodb';
import type { AnswerSource, ExecutedQuery } from '../conversations/answer';
import type { AskOptions, ConversationMessage, Conversations } from '../conversations/conversations';
import { NotFoundError, ValidationError } from '../errors';
import type { ActiveLanguageModel } from '../llm-settings/llm-settings';
import type { PinnedAnswer, PinnedQueries, PinnedRunBlock } from '../pinned-queries/pinned-queries';
import type { Clock, SlackChannel, SlackGateway } from '../ports';
import type { SavedQuestions } from '../saved-questions/saved-questions';
import type { Jobs } from '../scheduler/scheduler';
import { toMrkdwn } from '../slack/render';
import type { Users } from '../users/users';
import { destinationChannel, resolveDestination, type ReportDestination, type ReportDestinationInput } from './destination';
import { REPORT_TITLE_MAX } from './report-options';
import { nextRunAt, validateSchedule, type ReportSchedule } from './schedule';

/** The Answer approving a Prompt draft pins: the Conversation's latest complete one, if any. */
export function approvableAnswer(messages: readonly ConversationMessage[]): Extract<ConversationMessage, { kind: 'answer' }> | undefined {
  const latest = messages.findLast((m) => m.kind === 'answer' && m.answer.status === 'complete');
  return latest?.kind === 'answer' ? latest : undefined;
}

/**
 * `draft` until a person approves its queries; `active` runs on schedule; `paused` keeps its
 * Pinned Queries but doesn't run; `needsReapproval` after a failed Report Run, until someone
 * approves its queries again.
 */
export type ReportStatus = 'draft' | 'active' | 'paused' | 'needsReapproval';

/** The Report Run that put a Report into `needsReapproval`. */
export interface ReportFailure {
  runId: string;
  error: string;
  at: Date;
}

/** Where the Report's queries come from: an Answer in a Web Conversation, or a Saved Question. */
export type ReportOrigin = { kind: 'prompt'; conversationId: string } | { kind: 'savedQuestion'; savedQuestionId: string };

export interface Report {
  id: string;
  title: string;
  prompt: string;
  status: ReportStatus;
  origin: ReportOrigin;
  /** Null until approved. */
  pinned: PinnedAnswer | null;
  schedule: ReportSchedule;
  /** IANA timezone the schedule is read in. */
  timezone: string;
  destination: ReportDestination;
  createdBy: string;
  createdByName: string;
  createdAt: Date;
  updatedAt: Date;
  approvedBy: string | null;
  approvedAt: Date | null;
  /** When the next Report Run is due; null unless active. */
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  /** Set while `needsReapproval`. */
  failure: ReportFailure | null;
}

/** One generated page of a Report, frozen when it was made. Outlives its Report. */
export interface ReportRun {
  id: string;
  reportId: string;
  /** The Report's title and Prompt at the time. */
  title: string;
  prompt: string;
  /** `failed` when a Pinned Query or block failed; `error` says which. */
  status: 'complete' | 'failed';
  error?: string;
  /** In layout order, with their data as of the run. */
  blocks: PinnedRunBlock[];
  /** The agent's short commentary (markdown); null when the run failed or the LLM was unavailable. */
  commentary: string | null;
  sources: AnswerSource[];
  queries: ExecutedQuery[];
  /** The scheduled time this run was for. */
  scheduledFor: Date;
  timezone: string;
  startedAt: Date;
  finishedAt: Date;
  /** Set when posting to Slack failed. */
  deliveryError?: string;
}

/** A past Report Run in a Report's list, without its data. */
export type ReportRunSummary = Pick<ReportRun, 'id' | 'status' | 'error' | 'scheduledFor' | 'finishedAt' | 'timezone' | 'deliveryError'>;

export interface ReportSettingsInput {
  /** Default: the Prompt (or the Saved Question's title), shortened. */
  title?: string;
  schedule: ReportSchedule;
  timezone: string;
  destination: ReportDestinationInput;
}

export interface Reports {
  /**
   * Checks the settings (ValidationError, e.g. when the bot isn't in the channel), then asks the
   * agent the Prompt in a new Web Conversation and stores a draft pointing at it.
   */
  createFromPrompt(
    actorSlackUserId: string,
    input: ReportSettingsInput & { prompt: string; dataSourceIds?: readonly string[] },
    options?: AskOptions,
  ): Promise<Report>;
  /** A draft whose queries will come from a Saved Question the actor can see (NotFoundError otherwise). */
  createFromSavedQuestion(actorSlackUserId: string, input: ReportSettingsInput & { savedQuestionId: string }): Promise<Report>;
  get(actorSlackUserId: string, id: string): Promise<Report>;
  /** Every Report, most recently updated first. */
  list(actorSlackUserId: string): Promise<Report[]>;
  /**
   * Pins the queries (the latest complete Answer of the origin Conversation, or the Saved
   * Question's Pinned Queries), activates the Report and schedules its next run. The actor must
   * be able to see the origin (NotFoundError); ValidationError when there is nothing to pin or the
   * Report is neither a draft nor needs re-approval.
   */
  approve(actorSlackUserId: string, id: string): Promise<Report>;
  /**
   * Anyone: changes the title, schedule, timezone and destination, checked as when creating
   * (ValidationError). A DM goes to the Report's creator. An active Report is rescheduled.
   */
  update(actorSlackUserId: string, id: string, input: ReportSettingsInput): Promise<Report>;
  /** Anyone: stops an active Report from running, keeping its Pinned Queries (ValidationError unless active). */
  pause(actorSlackUserId: string, id: string): Promise<Report>;
  /** Anyone: schedules a paused Report again from now (ValidationError unless paused). */
  resume(actorSlackUserId: string, id: string): Promise<Report>;
  /** Admin only (ForbiddenError). Stops it running; its Report Runs are kept, so posted links still work. */
  remove(actorSlackUserId: string, id: string): Promise<void>;
  /** The Report's latest Report Runs (up to 100), newest first; also after the Report was deleted. */
  listRuns(actorSlackUserId: string, reportId: string): Promise<ReportRunSummary[]>;
  /** Any Report Run, for any signed-in user. */
  getRun(actorSlackUserId: string, runId: string): Promise<ReportRun>;
  /** Admin only (ForbiddenError): deletes one Report Run (NotFoundError when it doesn't exist). */
  removeRun(actorSlackUserId: string, runId: string): Promise<void>;
  /** Channels the bot is in, to choose a destination from. Rejects when Slack can't list them. */
  slackChannels(actorSlackUserId: string): Promise<SlackChannel[]>;
}

type ReportDoc = Omit<Report, 'id'> & { _id: string };
type ReportRunDoc = Omit<ReportRun, 'id'> & { _id: string };

interface Deps {
  db: Db;
  clock: Clock;
  users: Users;
  slack: SlackGateway;
  llm: ActiveLanguageModel;
  conversations: Conversations;
  savedQuestions: SavedQuestions;
  pinnedQueries: PinnedQueries;
  jobs: Jobs;
  /** The web app's URL; Report Run links point at it. */
  appUrl?: string;
  onError?: (error: unknown) => void;
  audit: AuditRecorder;
}

export { REPORT_TITLE_MAX };
export type { ReportDestination, ReportDestinationInput };
export const REPORT_JOB = 'report';
/** Rows of each result the commentary model sees. */
const COMMENTARY_ROWS = 50;
const COMMENTARY_MAX_CHARS = 12_000;
const RUNS_LISTED = 100;

export function reportRunPath(runId: string): string {
  return `/reports/runs/${runId}`;
}

export function reportPath(reportId: string): string {
  return `/reports/${reportId}`;
}

export function createReports(deps: Deps): Reports {
  const { db, clock, users, slack, conversations, savedQuestions, pinnedQueries, jobs, audit } = deps;
  const reports = db.collection<ReportDoc>('reports');
  const runs = db.collection<ReportRunDoc>('reportRuns');

  async function load(id: string): Promise<ReportDoc> {
    const doc = await reports.findOne({ _id: id });
    if (!doc) throw new NotFoundError('Report not found.');
    return doc;
  }

  async function audited(actor: string, action: string, report: { id: string; title: string }, details?: Record<string, unknown>) {
    await audit.record({ actor, type: 'report', action, target: { id: report.id, name: report.title }, details });
  }

  /** Applies `fields` if the Report is still in `status` (it may have changed since it was read). */
  async function setIfStatus(id: string, status: ReportStatus, fields: Partial<ReportDoc>): Promise<Report> {
    const updated = await reports.findOneAndUpdate({ _id: id, status }, { $set: fields }, { returnDocument: 'after' });
    if (!updated) throw new ValidationError('The Report changed meanwhile. Reload and try again.');
    return toReport(updated);
  }

  /**
   * Validates title, schedule, timezone and destination; the bot must be in a destination channel.
   * A DM goes to `dmTo`: the Report's creator.
   */
  async function settingsOf(dmTo: string, input: ReportSettingsInput, fallbackTitle: string) {
    const fieldErrors: Record<string, string> = {};
    let scheduled: ReturnType<typeof validateSchedule> | null = null;
    try {
      scheduled = validateSchedule(input.schedule, input.timezone);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      Object.assign(fieldErrors, error.fieldErrors);
    }
    const resolved = await resolveDestination(slack, dmTo, input.destination);
    if (!resolved.ok) fieldErrors.destination = resolved.error;
    const destination = resolved.ok ? resolved.destination : null;
    const title = shorten(input.title?.trim() || fallbackTitle);
    if (!title) fieldErrors.title = 'Give the Report a title.';
    if (Object.keys(fieldErrors).length > 0 || !scheduled || !destination) {
      throw new ValidationError(fieldErrors.destination ?? 'Check the Report settings.', fieldErrors);
    }
    return { title, ...scheduled, destination };
  }

  async function insertDraft(actor: string, fields: Pick<Report, 'title' | 'prompt' | 'origin' | 'schedule' | 'timezone' | 'destination'>) {
    const now = clock.now();
    const doc: ReportDoc = {
      _id: randomUUID(),
      ...fields,
      status: 'draft',
      pinned: null,
      createdBy: actor,
      createdByName: (await users.get(actor))?.name ?? actor,
      createdAt: now,
      updatedAt: now,
      approvedBy: null,
      approvedAt: null,
      nextRunAt: null,
      lastRunAt: null,
      failure: null,
    };
    await reports.insertOne(doc);
    await audited(actor, 'created', { id: doc._id, title: doc.title }, { origin: doc.origin.kind });
    return toReport(doc);
  }

  async function pinnedFromOrigin(actor: string, origin: ReportOrigin): Promise<PinnedAnswer> {
    if (origin.kind === 'savedQuestion') return (await savedQuestions.get(actor, origin.savedQuestionId)).pinned;
    const { messages } = await conversations.get(actor, origin.conversationId);
    const answer = approvableAnswer(messages);
    if (!answer) throw new ValidationError('The agent has no complete Answer to approve yet.');
    return pinnedQueries.pin(answer.answer);
  }

  async function commentaryFor(report: ReportDoc, blocks: PinnedRunBlock[]): Promise<string | null> {
    try {
      const { text, usage } = await generateText({
        model: await deps.llm.getModel(),
        system:
          'You write the commentary for a scheduled business report. In 2 to 4 short sentences, say what stands out ' +
          'in the data below: the largest values, notable changes, anything surprising. Use only the numbers given; ' +
          'never invent figures. Plain markdown, no headings, no tables.',
        prompt: `Report: ${report.title}\nIts Prompt: ${report.prompt}\n\n${describeData(blocks)}`,
      });
      await audit.record(
        ...tokenEntries(BOTLEY_ACTOR, usage, await deps.llm.choice(), 'report_commentary', { kind: 'report', id: report._id }),
      );
      return text.trim() || null;
    } catch (error) {
      deps.onError?.(error);
      return null;
    }
  }

  /** A Slack link on its own line to a page of the web app; empty without an app URL. */
  function slackLink(path: string, label: string): string {
    return deps.appUrl ? `\n<${deps.appUrl.replace(/\/+$/, '')}${path}|${label}>` : '';
  }

  /** Posts the run to the destination; `needsReapproval` when this failure stopped the Report. */
  async function deliver(report: ReportDoc, run: ReportRunDoc, needsReapproval: boolean): Promise<string | undefined> {
    const runLink = slackLink(reportRunPath(run._id), 'Open the Report Run');
    const title = toMrkdwn(report.title);
    const text =
      run.status === 'complete'
        ? `*${title}*${run.commentary ? `\n${toMrkdwn(run.commentary)}` : ''}${runLink}`
        : `:warning: *${title}* could not be completed: ${toMrkdwn(run.error ?? 'a Pinned Query failed.')}` +
          (needsReapproval ? '\nIt is stopped and needs re-approval: fix its queries, then approve them again.' : '') +
          runLink +
          slackLink(reportPath(report._id), 'Open the Report');
    try {
      await slack.postMessage({ channel: destinationChannel(report.destination), text });
      return undefined;
    } catch (error) {
      deps.onError?.(error);
      return error instanceof Error ? error.message : 'Posting to Slack failed.';
    }
  }

  async function recordDelivery(run: ReportRunDoc, deliveryError: string | undefined) {
    if (deliveryError) await runs.updateOne({ _id: run._id }, { $set: { deliveryError } });
  }

  /** The scheduler's handler: one Report Run, then when the next is due. */
  async function runReport(reportId: string, { runAt }: { runAt: Date }): Promise<Date | null> {
    const report = await reports.findOne({ _id: reportId });
    if (report?.status !== 'active' || !report.pinned) return null;
    const result = await pinnedQueries.run(report.pinned);
    await audit.record(...queryEntries(BOTLEY_ACTOR, result.queries, { kind: 'report', id: reportId }));
    const commentary = result.status === 'complete' ? await commentaryFor(report, result.blocks) : null;
    const run: ReportRunDoc = {
      _id: randomUUID(),
      reportId,
      title: report.title,
      prompt: report.prompt,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
      blocks: result.blocks,
      commentary,
      sources: result.sources,
      queries: result.queries,
      scheduledFor: runAt,
      timezone: report.timezone,
      startedAt: result.startedAt,
      finishedAt: clock.now(),
    };
    await runs.insertOne(run);

    if (run.status === 'failed') {
      // Paused, edited or deleted meanwhile: that change wins, and the notice doesn't claim otherwise.
      const failure: ReportFailure = { runId: run._id, error: run.error ?? 'A Pinned Query failed.', at: run.finishedAt };
      const { modifiedCount } = await reports.updateOne(
        { _id: reportId, status: 'active' },
        { $set: { status: 'needsReapproval', failure, lastRunAt: run.finishedAt, nextRunAt: null } },
      );
      await recordDelivery(run, await deliver(report, run, modifiedCount > 0));
      return null;
    }
    await recordDelivery(run, await deliver(report, run, false));
    // Re-read: the Report may have been paused, edited or deleted while it ran, and that change set its job.
    const current = await reports.findOne({ _id: reportId, status: 'active' });
    if (!current) return null;
    const next = nextRunAt(current.schedule, current.timezone, clock.now());
    await reports.updateOne({ _id: reportId, status: 'active' }, { $set: { lastRunAt: run.finishedAt, nextRunAt: next } });
    return next;
  }

  jobs.handle(REPORT_JOB, runReport);

  return {
    async createFromPrompt(actor, input, options) {
      const prompt = input.prompt.trim();
      if (!prompt) throw new ValidationError('Write a Prompt first.', { prompt: 'Required' });
      const settings = await settingsOf(actor, input, prompt);
      const conversation = await conversations.startWeb(actor, { dataSourceIds: input.dataSourceIds });
      await conversations.ask(actor, conversation.id, prompt, options);
      return insertDraft(actor, { ...settings, prompt, origin: { kind: 'prompt', conversationId: conversation.id } });
    },

    async createFromSavedQuestion(actor, input) {
      const question = await savedQuestions.get(actor, input.savedQuestionId);
      const settings = await settingsOf(actor, input, question.title);
      return insertDraft(actor, {
        ...settings,
        prompt: question.prompt,
        origin: { kind: 'savedQuestion', savedQuestionId: question.id },
      });
    },

    async get(_actor, id) {
      return toReport(await load(id));
    },

    async list() {
      return (await reports.find({}).sort({ updatedAt: -1 }).toArray()).map(toReport);
    },

    async approve(actor, id) {
      const doc = await load(id);
      if (doc.status !== 'draft' && doc.status !== 'needsReapproval') {
        throw new ValidationError('Only a draft, or a Report that needs re-approval, can be approved.');
      }
      const pinned = await pinnedFromOrigin(actor, doc.origin);
      const now = clock.now();
      const next = nextRunAt(doc.schedule, doc.timezone, now);
      const updated = await reports.findOneAndUpdate(
        { _id: id, status: doc.status },
        { $set: { status: 'active', pinned, approvedBy: actor, approvedAt: now, nextRunAt: next, failure: null, updatedAt: now } },
        { returnDocument: 'after' },
      );
      if (!updated) throw new ValidationError('The Report changed meanwhile. Reload and try again.');
      await jobs.set(REPORT_JOB, id, next);
      await audited(actor, 'approved', { id, title: updated.title });
      return toReport(updated);
    },

    async update(actor, id, input) {
      const doc = await load(id);
      const settings = await settingsOf(doc.createdBy, input, doc.title);
      const now = clock.now();
      const next = doc.status === 'active' ? nextRunAt(settings.schedule, settings.timezone, now) : null;
      const updated = await setIfStatus(id, doc.status, { ...settings, nextRunAt: next, updatedAt: now });
      if (doc.status === 'active') await jobs.set(REPORT_JOB, id, next);
      await audited(actor, 'updated', updated, {
        schedule: settings.schedule,
        timezone: settings.timezone,
        destination: settings.destination,
      });
      return updated;
    },

    async pause(actor, id) {
      const doc = await load(id);
      if (doc.status !== 'active') throw new ValidationError('Only an active Report can be paused.');
      const updated = await setIfStatus(id, 'active', { status: 'paused', nextRunAt: null, updatedAt: clock.now() });
      await jobs.set(REPORT_JOB, id, null);
      await audited(actor, 'paused', updated);
      return updated;
    },

    async resume(actor, id) {
      const doc = await load(id);
      if (doc.status !== 'paused') throw new ValidationError('Only a paused Report can be resumed.');
      const now = clock.now();
      const next = nextRunAt(doc.schedule, doc.timezone, now);
      const updated = await setIfStatus(id, 'paused', { status: 'active', nextRunAt: next, updatedAt: now });
      await jobs.set(REPORT_JOB, id, next);
      await audited(actor, 'resumed', updated);
      return updated;
    },

    async remove(actor, id) {
      await users.requireAdmin(actor);
      const removed = await reports.findOneAndDelete({ _id: id });
      await jobs.set(REPORT_JOB, id, null);
      if (removed) await audited(actor, 'deleted', { id, title: removed.title });
    },

    async listRuns(_actor, reportId) {
      const docs = await runs
        .find({ reportId }, { projection: { blocks: 0, sources: 0, queries: 0, commentary: 0, prompt: 0 } })
        .sort({ startedAt: -1 })
        .limit(RUNS_LISTED)
        .toArray();
      return docs.map(({ _id, status, error, scheduledFor, finishedAt, timezone, deliveryError }) => ({
        id: _id,
        status,
        ...(error ? { error } : {}),
        scheduledFor,
        finishedAt,
        timezone,
        ...(deliveryError ? { deliveryError } : {}),
      }));
    },

    async getRun(_actor, runId) {
      const doc = await runs.findOne({ _id: runId });
      if (!doc) throw new NotFoundError('Report Run not found.');
      const { _id, ...rest } = doc;
      return { id: _id, ...rest };
    },

    async removeRun(actor, runId) {
      await users.requireAdmin(actor);
      const removed = await runs.findOneAndDelete({ _id: runId });
      if (!removed) throw new NotFoundError('Report Run not found.');
      await audit.record({
        actor,
        type: 'report_run',
        action: 'deleted',
        target: { id: runId, name: removed.title },
        details: { reportId: removed.reportId, scheduledFor: removed.scheduledFor },
      });
    },

    async slackChannels() {
      return slack.listChannels();
    },
  };
}

/** The run's tables and charts as compact text for the commentary model. */
function describeData(blocks: PinnedRunBlock[]): string {
  const parts = blocks.flatMap((b) => {
    if (b.status !== 'ok') return [];
    const { block } = b;
    if (block.type === 'table') {
      const header = block.columns.map((c) => c.name).join(' | ');
      const rows = block.rows.slice(0, COMMENTARY_ROWS).map((r) => r.map(cell).join(' | '));
      const more = block.rows.length > COMMENTARY_ROWS || block.truncated ? '\n(more rows not shown)' : '';
      return [`Table${block.title ? ` "${block.title}"` : ''}:\n${header}\n${rows.join('\n')}${more}`];
    }
    if (block.type === 'chart') {
      const rows = block.data.slice(0, COMMENTARY_ROWS).map((r) => JSON.stringify(r));
      return [`${block.kind} chart${block.title ? ` "${block.title}"` : ''}:\n${rows.join('\n')}`];
    }
    return [`Text: ${block.markdown}`];
  });
  const text = parts.join('\n\n');
  return text.length > COMMENTARY_MAX_CHARS ? `${text.slice(0, COMMENTARY_MAX_CHARS)}\n(cut short)` : text;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function shorten(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= REPORT_TITLE_MAX ? oneLine : `${oneLine.slice(0, REPORT_TITLE_MAX - 1)}…`;
}

function toReport(doc: ReportDoc): Report {
  const { _id, ...rest } = doc;
  // Reports stored before failures were tracked have no `failure` field.
  return { id: _id, ...rest, failure: rest.failure ?? null };
}

/** Titles of the Reports made from this Conversation: (re-)approving them pins its latest Answer. */
export async function reportsMadeFrom(db: Db, conversationId: string): Promise<string[]> {
  const docs = await db
    .collection<ReportDoc>('reports')
    .find({ 'origin.kind': 'prompt', 'origin.conversationId': conversationId }, { projection: { title: 1 } })
    .toArray();
  return docs.map((d) => d.title);
}

export async function ensureReportIndexes(db: Db) {
  await db.collection('reports').createIndex({ updatedAt: -1 });
  await db.collection('reportRuns').createIndex({ reportId: 1, startedAt: -1 });
}
