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
   * Answers `prompt` in the Conversation and stores both. Resolves with a `failed` Answer
   * (never rejects) when the agent cannot finish; rejects on access or input errors.
   */
  ask(actorSlackUserId: string, conversationId: string, prompt: string, options?: AskOptions): Promise<Answer>;
  /** NotFoundError unless `actor` is a Participant. */
  get(actorSlackUserId: string, conversationId: string): Promise<ConversationWithMessages>;
  /** Conversations `actor` took part in that have at least one Prompt, most recent first. */
  list(actorSlackUserId: string, options?: { limit?: number }): Promise<Conversation[]>;
}

interface ConversationDoc {
  _id: string;
  source: ConversationSource;
  title: string;
  participants: string[];
  messageCount: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
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

  async function history(conversationId: string): Promise<ModelMessage[]> {
    const docs = await messages.find({ conversationId }).sort({ seq: 1 }).toArray();
    return docs.map((m): ModelMessage =>
      m.kind === 'prompt' ? { role: 'user', content: m.text } : { role: 'assistant', content: summarize(m.answer) },
    );
  }

  return {
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

    async ask(actor, conversationId, prompt, options = {}) {
      const text = prompt.trim();
      if (!text) throw new ValidationError('Write a Prompt first.', { prompt: 'Required' });
      if (text.length > MAX_PROMPT_LENGTH) {
        throw new ValidationError(`Prompts are limited to ${MAX_PROMPT_LENGTH} characters.`, { prompt: 'Too long' });
      }
      const conversation = await loadVisible(actor, conversationId);
      const context = await history(conversation._id);
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
      await append(conversation._id, { kind: 'answer', promptId: promptDoc._id, answer, createdAt: clock.now() });
      return answer;
    },

    async get(actor, id) {
      const conversation = await loadVisible(actor, id);
      const docs = await messages.find({ conversationId: id }).sort({ seq: 1 }).toArray();
      return { conversation: toConversation(conversation), messages: docs.map(toMessage) };
    },

    async list(actor, { limit = 50 } = {}) {
      const docs = await conversations
        .find({ participants: actor, messageCount: { $gt: 0 } })
        .sort({ updatedAt: -1 })
        .limit(limit)
        .toArray();
      return docs.map(toConversation);
    },
  };
}

function toConversation(doc: ConversationDoc): Conversation {
  const { _id, source, title, participants, createdBy, createdAt, updatedAt } = doc;
  return { id: _id, source, title, participants, createdBy, createdAt, updatedAt };
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
  await db
    .collection('conversations')
    .createIndex({ 'source.channel': 1, 'source.threadTs': 1 }, { unique: true, partialFilterExpression: { 'source.kind': 'slack' } });
  await db.collection('conversationMessages').createIndex({ conversationId: 1, seq: 1 }, { unique: true });
}
