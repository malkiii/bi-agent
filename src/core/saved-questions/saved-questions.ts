/**
 * Saved Questions: an Answer saved by a Participant so it can be re-run on demand. Saving pins
 * the Answer's queries and layout (Pinned Queries); a re-run executes them without the LLM.
 * Private ones are visible to their owner only; shared ones can be browsed and run by everyone.
 * Mongo collection `savedQuestions`.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { queryEntries, type AuditRecorder } from '../audit/audit';
import type { Conversations } from '../conversations/conversations';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors';
import type { PinnedAnswer, PinnedQueries, PinnedRun } from '../pinned-queries/pinned-queries';
import type { Clock } from '../ports';
import type { Users } from '../users/users';

export type SavedQuestionVisibility = 'private' | 'shared';

export interface SavedQuestion {
  id: string;
  title: string;
  /** The Prompt the Answer replied to. */
  prompt: string;
  ownerSlackUserId: string;
  /** The owner's display name when saved. */
  ownerName: string;
  visibility: SavedQuestionVisibility;
  pinned: PinnedAnswer;
  /** Where it was saved from. */
  origin: { conversationId: string; answerMessageId: string };
  createdAt: Date;
  updatedAt: Date;
  lastRunAt: Date | null;
}

export interface SaveQuestionInput {
  conversationId: string;
  answerMessageId: string;
  /** Default: the Prompt, shortened. */
  title?: string;
  /** Default `private`. */
  visibility?: SavedQuestionVisibility;
}

export interface SavedQuestions {
  /** Pins an Answer the actor can see. NotFoundError unless a Participant; ValidationError if nothing to pin. */
  save(actorSlackUserId: string, input: SaveQuestionInput): Promise<SavedQuestion>;
  /** NotFoundError unless the actor owns it or it is shared. */
  get(actorSlackUserId: string, id: string): Promise<SavedQuestion>;
  /** `mine`: the actor's own (any visibility); `shared`: everyone's shared ones. Most recent first. */
  list(actorSlackUserId: string, options: { scope: 'mine' | 'shared'; limit?: number }): Promise<SavedQuestion[]>;
  /** Re-runs the Pinned Queries (no LLM). A failing query gives `status: 'failed'`, not a rejection. */
  run(actorSlackUserId: string, id: string): Promise<PinnedRun>;
  /** Owner only (ForbiddenError otherwise). */
  update(actorSlackUserId: string, id: string, change: { title?: string; visibility?: SavedQuestionVisibility }): Promise<SavedQuestion>;
  /** Owner or admin (ForbiddenError otherwise). */
  delete(actorSlackUserId: string, id: string): Promise<void>;
}

type SavedQuestionDoc = Omit<SavedQuestion, 'id'> & { _id: string };

interface Deps {
  db: Db;
  clock: Clock;
  users: Users;
  conversations: Conversations;
  pinnedQueries: PinnedQueries;
  audit: AuditRecorder;
}

export const SAVED_QUESTION_TITLE_MAX = 120;

export function createSavedQuestions({ db, clock, users, conversations, pinnedQueries, audit }: Deps): SavedQuestions {
  const collection = db.collection<SavedQuestionDoc>('savedQuestions');

  async function loadVisible(actor: string, id: string): Promise<SavedQuestionDoc> {
    const doc = await collection.findOne({ _id: id, $or: [{ ownerSlackUserId: actor }, { visibility: 'shared' }] });
    if (!doc) throw new NotFoundError('Saved Question not found.');
    return doc;
  }

  return {
    async save(actor, input) {
      const { messages } = await conversations.get(actor, input.conversationId);
      const message = messages.find((m) => m.id === input.answerMessageId);
      if (message?.kind !== 'answer') throw new NotFoundError('Answer not found.');
      const prompt = messages.find((m) => m.id === message.promptId);
      const promptText = prompt?.kind === 'prompt' ? prompt.text : '';
      const pinned = pinnedQueries.pin(message.answer);
      const now = clock.now();
      const doc: SavedQuestionDoc = {
        _id: randomUUID(),
        title: titleOf(input.title, promptText),
        prompt: promptText,
        ownerSlackUserId: actor,
        ownerName: (await users.get(actor))?.name ?? actor,
        visibility: visibilityOf(input.visibility),
        pinned,
        origin: { conversationId: input.conversationId, answerMessageId: message.id },
        createdAt: now,
        updatedAt: now,
        lastRunAt: null,
      };
      await collection.insertOne(doc);
      return toSavedQuestion(doc);
    },

    async get(actor, id) {
      return toSavedQuestion(await loadVisible(actor, id));
    },

    async list(actor, { scope, limit = 100 }) {
      const filter = scope === 'mine' ? { ownerSlackUserId: actor } : { visibility: 'shared' as const };
      const docs = await collection.find(filter).sort({ updatedAt: -1 }).limit(limit).toArray();
      return docs.map(toSavedQuestion);
    },

    async run(actor, id) {
      const doc = await loadVisible(actor, id);
      const run = await pinnedQueries.run(doc.pinned);
      await audit.record(...queryEntries(actor, run.queries, { kind: 'saved_question', id }));
      await collection.updateOne({ _id: id }, { $set: { lastRunAt: run.finishedAt } });
      return run;
    },

    async update(actor, id, change) {
      const doc = await loadVisible(actor, id);
      if (doc.ownerSlackUserId !== actor) throw new ForbiddenError('Only the owner can change this Saved Question.');
      const set: Partial<SavedQuestionDoc> = { updatedAt: clock.now() };
      if (change.title !== undefined) set.title = titleOf(change.title, doc.prompt);
      if (change.visibility !== undefined) set.visibility = visibilityOf(change.visibility);
      const updated = await collection.findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: 'after' });
      if (!updated) throw new NotFoundError('Saved Question not found.');
      return toSavedQuestion(updated);
    },

    async delete(actor, id) {
      const doc = await loadVisible(actor, id);
      if (doc.ownerSlackUserId !== actor && (await users.get(actor))?.role !== 'admin') {
        throw new ForbiddenError('Only the owner or an admin can delete this Saved Question.');
      }
      await collection.deleteOne({ _id: id });
    },
  };
}

function titleOf(title: string | undefined, prompt: string): string {
  const text = (title?.trim() || prompt.trim()).replace(/\s+/g, ' ');
  if (!text) throw new ValidationError('Give the Saved Question a title.', { title: 'Required' });
  return text.length <= SAVED_QUESTION_TITLE_MAX ? text : `${text.slice(0, SAVED_QUESTION_TITLE_MAX - 1)}…`;
}

function visibilityOf(visibility: string | undefined): SavedQuestionVisibility {
  if (visibility === undefined || visibility === 'private') return 'private';
  if (visibility === 'shared') return 'shared';
  throw new ValidationError('Visibility must be private or shared.', { visibility: 'Invalid' });
}

function toSavedQuestion(doc: SavedQuestionDoc): SavedQuestion {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

export async function ensureSavedQuestionIndexes(db: Db) {
  await db.collection('savedQuestions').createIndex({ ownerSlackUserId: 1, updatedAt: -1 });
  await db.collection('savedQuestions').createIndex({ visibility: 1, updatedAt: -1 });
}
