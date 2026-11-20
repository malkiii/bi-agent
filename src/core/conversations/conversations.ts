/**
 * Conversations: answer a Prompt in a Conversation, and read back Conversations a person
 * took part in. A Conversation has exactly one Source (web now; Slack is identified by
 * channel + thread timestamp). Messages are stored in order: each Prompt is followed by
 * its Answer.
 */
import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import type { Db } from 'mongodb';
import { runAgent } from '../agent/agent';
import { createAgentCatalog } from '../agent/catalog';
import type { AgentToolkitFactory } from '../agent/tools';
import type { DataSources } from '../data-sources/data-sources';
import { NotFoundError, ValidationError } from '../errors';
import type { Clock, LanguageModelProvider } from '../ports';
import type { Answer, AnswerEvent } from './answer';

export type ConversationSource = { kind: 'web' } | { kind: 'slack'; channel: string; threadTs: string };

export interface Conversation {
  id: string;
  source: ConversationSource;
  /** The first Prompt, shortened; empty until the first Prompt. */
  title: string;
  /** Slack user IDs of everyone who sent a Prompt (for web, also the person who started it). */
  participants: string[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  /** Set on a Fork: the Slack Conversation it started from. */
  forkedFrom?: { conversationId: string };
}

export interface HistoryOptions {
  source?: ConversationSource['kind'];
  /** 1-based. */
  page?: number;
  pageSize?: number;
}

export interface HistoryPage {
  conversations: Conversation[];
  page: number;
  hasNextPage: boolean;
}

export type ConversationMessage =
  | { id: string; kind: 'prompt'; authorSlackUserId: string; text: string; createdAt: Date }
  | { id: string; kind: 'answer'; promptId: string; answer: Answer; createdAt: Date };

export interface ConversationWithMessages {
  conversation: Conversation;
  messages: ConversationMessage[];
}

export interface AskOptions {
  /** Receives progress, executed queries and Result Blocks as they happen. */
  onEvent?: (event: AnswerEvent) => void;
  signal?: AbortSignal;
}

export interface Conversations {
  /** A new, empty Web Conversation started by `actor`. */
  startWeb(actorSlackUserId: string): Promise<Conversation>;
  /**
   * Answers `prompt` in a Web Conversation and stores both. Resolves with a `failed` Answer
   * (never rejects) when the agent cannot finish; rejects on access or input errors, and with
   * ValidationError for a Slack Conversation (continue it in Slack, or fork it).
   */
  ask(actorSlackUserId: string, conversationId: string, prompt: string, options?: AskOptions): Promise<Answer>;
  /**
   * Like `ask` for any Source (the Slack bot answers Slack threads with it), and also returns
   * the id of the stored Answer message (Slack puts it in the "Show query" button).
   */
  answerPrompt(
    actorSlackUserId: string,
    conversationId: string,
    prompt: string,
    options?: AskOptions,
  ): Promise<{ answer: Answer; answerMessageId: string }>;
  /**
   * The Slack Conversation for this thread, created on first use. `actor` is added to
   * `participants` (they are about to send a Prompt in it).
   */
  findOrStartSlack(actorSlackUserId: string, thread: { channel: string; threadTs: string }): Promise<Conversation>;
  /**
   * One stored Answer by its message id, without a Participant check: for Slack's
   * "Show query" button, which only people who can see the Answer in Slack can press.
   */
  getAnswer(answerMessageId: string): Promise<Answer>;
  /** One stored Answer by its message id; NotFoundError unless `actor` is a Participant of its Conversation. */
  getVisibleAnswer(actorSlackUserId: string, answerMessageId: string): Promise<Answer>;
  /** NotFoundError unless `actor` is a Participant. */
  get(actorSlackUserId: string, conversationId: string): Promise<ConversationWithMessages>;
  /** Conversations `actor` took part in that have at least one Prompt, most recent first. */
  list(actorSlackUserId: string, options?: { limit?: number }): Promise<Conversation[]>;
  /** Like `list`, one page at a time and optionally only one Source. */
  history(actorSlackUserId: string, options?: HistoryOptions): Promise<HistoryPage>;
  /**
   * A Fork: a new Web Conversation for `actor` that starts from a Slack Conversation's
   * history (its messages are duplicated into the Fork, so they are model context). The Slack Conversation is not
   * touched. NotFoundError unless `actor` is a Participant; ValidationError for a non-Slack one.
   */
  fork(actorSlackUserId: string, slackConversationId: string): Promise<Conversation>;
}

export const HISTORY_PAGE_SIZE = 20;

interface ConversationDoc {
  _id: string;
  source: ConversationSource;
  title: string;
  participants: string[];
  messageCount: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  forkedFrom?: { conversationId: string };
}

type MessageBody =
  | { kind: 'prompt'; authorSlackUserId: string; text: string; createdAt: Date }
  | { kind: 'answer'; promptId: string; answer: Answer; createdAt: Date };

type MessageDoc = { _id: string; conversationId: string; seq: number } & MessageBody;

interface Deps {
  db: Db;
  clock: Clock;
  llm: LanguageModelProvider;
  dataSources: DataSources;
  toolkits?: readonly AgentToolkitFactory[];
  onAgentError?: (error: unknown) => void;
}

const TITLE_LENGTH = 80;
export const MAX_PROMPT_LENGTH = 8_000;

export function createConversations({ db, clock, llm, dataSources, toolkits, onAgentError }: Deps): Conversations {
  const conversations = db.collection<ConversationDoc>('conversations');
  const messages = db.collection<MessageDoc>('conversationMessages');

  async function loadVisible(actor: string, id: string): Promise<ConversationDoc> {
    const doc = await conversations.findOne({ _id: id, participants: actor });
    if (!doc) throw new NotFoundError('Conversation not found.');
    return doc;
  }

  async function append(conversationId: string, message: MessageBody): Promise<MessageDoc> {
    const counted = await conversations.findOneAndUpdate(
      { _id: conversationId },
      { $inc: { messageCount: 1 }, $set: { updatedAt: message.createdAt } },
      { returnDocument: 'after' },
    );
    if (!counted) throw new NotFoundError('Conversation not found.');
    const doc = { ...message, _id: randomUUID(), conversationId, seq: counted.messageCount } as MessageDoc;
    await messages.insertOne(doc);
    return doc;
  }

  async function modelContext(conversationId: string): Promise<ModelMessage[]> {
    const docs = await messages.find({ conversationId }).sort({ seq: 1 }).toArray();
    return docs.map((m): ModelMessage =>
      m.kind === 'prompt' ? { role: 'user', content: m.text } : { role: 'assistant', content: summarize(m.answer) },
    );
  }

  const api: Conversations = {
    async startWeb(actor) {
      const now = clock.now();
      const doc: ConversationDoc = {
        _id: randomUUID(),
        source: { kind: 'web' },
        title: '',
        participants: [actor],
        messageCount: 0,
        createdBy: actor,
        createdAt: now,
        updatedAt: now,
      };
      await conversations.insertOne(doc);
      return toConversation(doc);
    },

    async ask(actor, conversationId, prompt, options) {
      const conversation = await loadVisible(actor, conversationId);
      if (conversation.source.kind !== 'web') {
        throw new ValidationError('This Conversation lives in Slack. Reply in its thread, or open it in the dashboard as a Fork.');
      }
      return (await api.answerPrompt(actor, conversationId, prompt, options)).answer;
    },

    async findOrStartSlack(actor, { channel, threadTs }) {
      const now = clock.now();
      const filter = { 'source.kind': 'slack', 'source.channel': channel, 'source.threadTs': threadTs } as const;
      const update = {
        $addToSet: { participants: actor },
        $setOnInsert: {
          _id: randomUUID(),
          source: { kind: 'slack' as const, channel, threadTs },
          title: '',
          messageCount: 0,
          createdBy: actor,
          createdAt: now,
          updatedAt: now,
        },
      };
      try {
        const doc = await conversations.findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'after' });
        return toConversation(doc!);
      } catch (error) {
        // Two first Prompts in the same thread raced on the unique index: the other one created it.
        if ((error as { code?: number }).code !== 11000) throw error;
        const doc = await conversations.findOneAndUpdate(filter, { $addToSet: { participants: actor } }, { returnDocument: 'after' });
        return toConversation(doc!);
      }
    },

    async getAnswer(answerMessageId) {
      const doc = await messages.findOne({ _id: answerMessageId, kind: 'answer' });
      if (!doc || doc.kind !== 'answer') throw new NotFoundError('Answer not found.');
      return doc.answer;
    },

    async answerPrompt(actor, conversationId, prompt, options = {}) {
      const text = prompt.trim();
      if (!text) throw new ValidationError('Write a Prompt first.', { prompt: 'Required' });
      if (text.length > MAX_PROMPT_LENGTH) {
        throw new ValidationError(`Prompts are limited to ${MAX_PROMPT_LENGTH} characters.`, { prompt: 'Too long' });
      }
      const conversation = await loadVisible(actor, conversationId);
      const context = await modelContext(conversation._id);
      if (!conversation.title) {
        await conversations.updateOne({ _id: conversation._id }, { $set: { title: shorten(text, TITLE_LENGTH) } });
      }
      const promptDoc = await append(conversation._id, {
        kind: 'prompt',
        authorSlackUserId: actor,
        text,
        createdAt: clock.now(),
      });

      const answer = await runAgent({
        llm,
        catalog: createAgentCatalog(dataSources),
        history: context,
        prompt: text,
        now: () => clock.now(),
        onEvent: options.onEvent,
        signal: options.signal,
        onError: onAgentError,
        toolkits,
      });
      const stored = await append(conversation._id, { kind: 'answer', promptId: promptDoc._id, answer, createdAt: clock.now() });
      return { answer, answerMessageId: stored._id };
    },

    async get(actor, id) {
      const conversation = await loadVisible(actor, id);
      const docs = await messages.find({ conversationId: id }).sort({ seq: 1 }).toArray();
      return { conversation: toConversation(conversation), messages: docs.map(toMessage) };
    },

    async list(actor, { limit = 50 } = {}) {
      const docs = await conversations
        .find({ participants: actor, messageCount: { $gt: 0 } })
        .sort({ updatedAt: -1, _id: -1 })
        .limit(limit)
        .toArray();
      return docs.map(toConversation);
    },

    async getVisibleAnswer(actor, answerMessageId) {
      const doc = await messages.findOne({ _id: answerMessageId, kind: 'answer' });
      if (!doc || doc.kind !== 'answer') throw new NotFoundError('Answer not found.');
      const visible = await conversations.countDocuments({ _id: doc.conversationId, participants: actor }, { limit: 1 });
      if (!visible) throw new NotFoundError('Answer not found.');
      return doc.answer;
    },

    async history(actor, { source, page = 1, pageSize = HISTORY_PAGE_SIZE } = {}) {
      const current = Math.max(1, Math.floor(page));
      const size = Math.min(100, Math.max(1, Math.floor(pageSize)));
      const docs = await conversations
        .find({ participants: actor, messageCount: { $gt: 0 }, ...(source ? { 'source.kind': source } : {}) })
        .sort({ updatedAt: -1, _id: -1 })
        .skip((current - 1) * size)
        .limit(size + 1)
        .toArray();
      return { conversations: docs.slice(0, size).map(toConversation), page: current, hasNextPage: docs.length > size };
    },

    async fork(actor, slackConversationId) {
      const original = await loadVisible(actor, slackConversationId);
      if (original.source.kind !== 'slack') throw new ValidationError('Only Slack Conversations can be forked.');
      const copied = await messages.find({ conversationId: original._id }).sort({ seq: 1 }).toArray();
      const now = clock.now();
      const doc: ConversationDoc = {
        _id: randomUUID(),
        source: { kind: 'web' },
        title: original.title,
        participants: [actor],
        messageCount: copied.length,
        createdBy: actor,
        createdAt: now,
        updatedAt: now,
        forkedFrom: { conversationId: original._id },
      };
      // Messages keep their order and content; Answers point at their copied Prompt.
      const ids = new Map(copied.map((m) => [m._id, randomUUID()]));
      const copies = copied.map((m): MessageDoc => {
        const base = { ...m, _id: ids.get(m._id)!, conversationId: doc._id };
        return base.kind === 'answer' ? { ...base, promptId: ids.get(base.promptId) ?? base.promptId } : base;
      });
      // Messages first: until the Conversation exists they are invisible; on failure, remove them.
      if (copies.length > 0) await messages.insertMany(copies);
      try {
        await conversations.insertOne(doc);
      } catch (error) {
        await messages.deleteMany({ conversationId: doc._id }).catch(() => undefined);
        throw error;
      }
      return toConversation(doc);
    },
  };
  return api;
}

function toConversation(doc: ConversationDoc): Conversation {
  const { _id, source, title, participants, createdBy, createdAt, updatedAt, forkedFrom } = doc;
  return { id: _id, source, title, participants, createdBy, createdAt, updatedAt, ...(forkedFrom ? { forkedFrom } : {}) };
}

function toMessage(doc: MessageDoc): ConversationMessage {
  return doc.kind === 'prompt'
    ? { id: doc._id, kind: 'prompt', authorSlackUserId: doc.authorSlackUserId, text: doc.text, createdAt: doc.createdAt }
    : { id: doc._id, kind: 'answer', promptId: doc.promptId, answer: doc.answer, createdAt: doc.createdAt };
}

function shorten(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ');
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** How an earlier Answer is shown to the model as context for follow-up Prompts. */
export function summarize(answer: Answer): string {
  if (answer.status === 'failed') return `(This Answer failed: ${answer.error ?? 'unknown error'})`;
  const parts = answer.blocks.map((b) => {
    switch (b.type) {
      case 'text':
        return b.markdown;
      case 'table':
        return `[Table${b.title ? ` "${b.title}"` : ''}: ${b.rows.length} rows; columns ${b.columns.map((c) => c.name).join(', ')}]`;
      case 'chart':
        return `[${b.kind} chart${b.title ? ` "${b.title}"` : ''} of ${b.resultId}]`;
      default:
        return '';
    }
  });
  const queries = answer.queries
    .filter((q) => q.ok)
    .map((q) => `[Query ${q.resultId} on ${q.dataSourceName} (${q.dataSourceId}): ${q.query}]`);
  return [...parts, ...queries].filter(Boolean).join('\n\n');
}

export async function ensureConversationIndexes(db: Db) {
  await db.collection('conversations').createIndex({ participants: 1, updatedAt: -1 });
  await db.collection('conversations').createIndex({ participants: 1, 'source.kind': 1, updatedAt: -1 });
  await db
    .collection('conversations')
    .createIndex({ 'source.channel': 1, 'source.threadTs': 1 }, { unique: true, partialFilterExpression: { 'source.kind': 'slack' } });
  await db.collection('conversationMessages').createIndex({ conversationId: 1, seq: 1 }, { unique: true });
}
