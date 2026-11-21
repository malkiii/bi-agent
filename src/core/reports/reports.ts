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
import { REPORT_TITLE_MAX } from './report-options';
import { nextRunAt, validateSchedule, type ReportSchedule } from './schedule';

/** The Answer approving a Prompt draft pins: the Conversation's latest complete one, if any. */
export function approvableAnswer(messages: readonly ConversationMessage[]): Extract<ConversationMessage, { kind: 'answer' }> | undefined {
  const latest = messages.findLast((m) => m.kind === 'answer' && m.answer.status === 'complete');
  return latest?.kind === 'answer' ? latest : undefined;
}

/** `draft` until a person approves its queries; `active` runs on schedule. */
export type ReportStatus = 'draft' | 'active';

export type ReportDestination = { kind: 'channel'; channel: string } | { kind: 'dm'; slackUserId: string };

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
  /** When the next Report Run is due; null while a draft. */
  nextRunAt: Date | null;
  lastRunAt: Date | null;
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

/** Destination as a form gives it: a channel id, or a DM to the person saving. */
export type ReportDestinationInput = { kind: 'channel'; channel: string } | { kind: 'dm' };

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
   * be able to see the origin (NotFoundError); ValidationError when there is nothing to pin.
   */
  approve(actorSlackUserId: string, id: string): Promise<Report>;
  /** Any Report Run, for any signed-in user. */
  getRun(actorSlackUserId: string, runId: string): Promise<ReportRun>;
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
}

export { REPORT_TITLE_MAX };
export const REPORT_JOB = 'report';
/** Rows of each result the commentary model sees. */
const COMMENTARY_ROWS = 50;
const COMMENTARY_MAX_CHARS = 12_000;

export function reportRunPath(runId: string): string {
  return `/reports/runs/${runId}`;
}

export function createReports(deps: Deps): Reports {
  const { db, clock, users, slack, conversations, savedQuestions, pinnedQueries, jobs } = deps;
  const reports = db.collection<ReportDoc>('reports');
  const runs = db.collection<ReportRunDoc>('reportRuns');

  async function load(id: string): Promise<ReportDoc> {
    const doc = await reports.findOne({ _id: id });
    if (!doc) throw new NotFoundError('Report not found.');
    return doc;
  }

  /** Validates title, schedule, timezone and destination; the bot must be in a destination channel. */
  async function settingsOf(actor: string, input: ReportSettingsInput, fallbackTitle: string) {
    const fieldErrors: Record<string, string> = {};
    let scheduled: ReturnType<typeof validateSchedule> | null = null;
    try {
      scheduled = validateSchedule(input.schedule, input.timezone);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      Object.assign(fieldErrors, error.fieldErrors);
    }
    let destination: ReportDestination | null = null;
    if (input.destination.kind === 'dm') {
      destination = { kind: 'dm', slackUserId: actor };
    } else {
      const channel = input.destination.channel.trim();
      if (!channel) fieldErrors.destination = 'Choose a channel.';
      else if (!(await slack.isBotInChannel(channel))) {
        fieldErrors.destination = 'Botley is not in that channel. Invite it with /invite @Botley, then save again.';
      } else destination = { kind: 'channel', channel };
    }
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
    };
    await reports.insertOne(doc);
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
      const { text } = await generateText({
        model: await deps.llm.getModel(),
        system:
          'You write the commentary for a scheduled business report. In 2 to 4 short sentences, say what stands out ' +
          'in the data below: the largest values, notable changes, anything surprising. Use only the numbers given; ' +
          'never invent figures. Plain markdown, no headings, no tables.',
        prompt: `Report: ${report.title}\nIts Prompt: ${report.prompt}\n\n${describeData(blocks)}`,
      });
      return text.trim() || null;
    } catch (error) {
      deps.onError?.(error);
      return null;
    }
  }

  async function deliver(report: ReportDoc, run: ReportRunDoc): Promise<string | undefined> {
    const url = deps.appUrl ? `${deps.appUrl.replace(/\/+$/, '')}${reportRunPath(run._id)}` : undefined;
    const link = url ? `\n<${url}|Open the Report Run>` : '';
    const title = toMrkdwn(report.title);
    const text =
      run.status === 'complete'
        ? `*${title}*${run.commentary ? `\n${toMrkdwn(run.commentary)}` : ''}${link}`
        : `:warning: *${title}* could not be completed: ${toMrkdwn(run.error ?? 'a Pinned Query failed.')}${link}`;
    const channel = report.destination.kind === 'channel' ? report.destination.channel : report.destination.slackUserId;
    try {
      await slack.postMessage({ channel, text });
      return undefined;
    } catch (error) {
      deps.onError?.(error);
      return error instanceof Error ? error.message : 'Posting to Slack failed.';
    }
  }

  /** The scheduler's handler: one Report Run, then when the next is due. */
  async function runReport(reportId: string, { runAt }: { runAt: Date }): Promise<Date | null> {
    const report = await reports.findOne({ _id: reportId });
    if (report?.status !== 'active' || !report.pinned) return null;
    const result = await pinnedQueries.run(report.pinned);
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
    const deliveryError = await deliver(report, run);
    if (deliveryError) await runs.updateOne({ _id: run._id }, { $set: { deliveryError } });

    const next = nextRunAt(report.schedule, report.timezone, clock.now());
    await reports.updateOne({ _id: reportId }, { $set: { lastRunAt: run.finishedAt, nextRunAt: next } });
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
      const pinned = await pinnedFromOrigin(actor, doc.origin);
      const now = clock.now();
      const next = nextRunAt(doc.schedule, doc.timezone, now);
      const updated = await reports.findOneAndUpdate(
        { _id: id },
        { $set: { status: 'active', pinned, approvedBy: actor, approvedAt: now, nextRunAt: next, updatedAt: now } },
        { returnDocument: 'after' },
      );
      if (!updated) throw new NotFoundError('Report not found.');
      await jobs.set(REPORT_JOB, id, next);
      return toReport(updated);
    },

    async getRun(_actor, runId) {
      const doc = await runs.findOne({ _id: runId });
      if (!doc) throw new NotFoundError('Report Run not found.');
      const { _id, ...rest } = doc;
      return { id: _id, ...rest };
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
  return { id: _id, ...rest };
}

export async function ensureReportIndexes(db: Db) {
  await db.collection('reports').createIndex({ updatedAt: -1 });
  await db.collection('reportRuns').createIndex({ reportId: 1, startedAt: -1 });
}
