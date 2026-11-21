/**
 * The audit log: an append-only record of Prompts, executed queries, token usage, and every
 * change to configuration and scheduled work, with who made it. Modules write through an
 * `AuditRecorder`; only admins read it.
 */
import { ObjectId, type Db, type Filter } from 'mongodb';
import type { Clock, LlmChoice } from '../ports';
import type { ExecutedQuery } from '../conversations/answer';
import type { Users } from '../users/users';

/** The actor of entries written by scheduled work (Report Runs, KPI Alert checks), not by a person. */
export const BOTLEY_ACTOR = 'botley';

export const AUDIT_EVENT_TYPES = [
  'prompt',
  'query',
  'tokens',
  'data_source',
  'dataset',
  'channel_default',
  'role',
  'llm_settings',
  'report',
  'report_run',
  'kpi',
  'kpi_alert',
  'conversation',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export interface AuditEntry {
  id: string;
  at: Date;
  /** Slack user ID of the person, or BOTLEY_ACTOR for scheduled work. */
  actor: string;
  type: AuditEventType;
  /** What happened, e.g. `created`, `deleted`, `asked`, `executed`. */
  action: string;
  /** The thing it happened to. */
  target?: { id: string; name?: string };
  details: Record<string, unknown>;
}

export type AuditEntryInput = Omit<AuditEntry, 'id' | 'at' | 'details'> & {
  details?: Record<string, unknown>;
};

export interface AuditFilter {
  actor?: string;
  type?: AuditEventType;
  /** Inclusive. */
  from?: Date;
  /** Exclusive. */
  to?: Date;
  /** 1-based. */
  page?: number;
  pageSize?: number;
}

export interface AuditPage {
  entries: AuditEntry[];
  page: number;
  hasNextPage: boolean;
}

/** How App Core modules write to the audit log. */
export interface AuditRecorder {
  record(...entries: AuditEntryInput[]): Promise<void>;
}

export interface AuditLog {
  /** Admin only (ForbiddenError): entries matching `filter`, newest first, one page at a time. */
  list(actorSlackUserId: string, filter?: AuditFilter): Promise<AuditPage>;
}

interface AuditDoc extends Omit<AuditEntry, 'id'> {
  /** ObjectIds grow in insertion order, so entries written at the same instant keep their order. */
  _id: ObjectId;
}

export const AUDIT_PAGE_SIZE = 50;

/** One `query` entry per executed query (failed ones too). `context` says what ran it, e.g. an Answer or a Report Run. */
export function queryEntries(
  actor: string,
  queries: readonly ExecutedQuery[],
  context: { kind: string; id: string },
): AuditEntryInput[] {
  return queries.map((q) => ({
    actor,
    type: 'query',
    action: 'executed',
    target: { id: q.dataSourceId, name: q.dataSourceName },
    details: {
      dataSourceId: q.dataSourceId,
      dataSourceName: q.dataSourceName,
      language: q.language,
      query: q.query,
      ok: q.ok,
      ...(q.error ? { error: q.error } : {}),
      rowCount: q.rowCount,
      durationMs: q.durationMs,
      context,
    },
  }));
}

/** A `tokens` entry, or none when the model call used no tokens (e.g. no LLM was configured). */
export function tokenEntries(
  actor: string,
  usage: { inputTokens?: number; outputTokens?: number },
  choice: LlmChoice | null,
  purpose: 'answer' | 'report_commentary' | 'alert_message',
  context: { kind: string; id: string },
): AuditEntryInput[] {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  if (inputTokens + outputTokens === 0) return [];
  return [
    {
      actor,
      type: 'tokens',
      action: 'used',
      details: { purpose, provider: choice?.provider ?? null, model: choice?.model ?? null, inputTokens, outputTokens, context },
    },
  ];
}

export function createAuditRecorder({ db, clock }: { db: Db; clock: Clock }): AuditRecorder {
  const docs = db.collection<AuditDoc>('auditLog');
  return {
    async record(...entries) {
      if (entries.length === 0) return;
      const at = clock.now();
      await docs.insertMany(entries.map((e) => ({ _id: new ObjectId(), at, details: {}, ...e })));
    },
  };
}

export function createAuditLog({ db, users }: { db: Db; users: Users }): AuditLog {
  const docs = db.collection<AuditDoc>('auditLog');
  return {
    async list(actor, { actor: byActor, type, from, to, page = 1, pageSize = AUDIT_PAGE_SIZE } = {}) {
      await users.requireAdmin(actor);
      const current = Math.max(1, Math.floor(page));
      const size = Math.min(200, Math.max(1, Math.floor(pageSize)));
      const filter: Filter<AuditDoc> = {};
      if (byActor) filter.actor = byActor;
      if (type) filter.type = type;
      if (from || to) filter.at = { ...(from && { $gte: from }), ...(to && { $lt: to }) };
      const found = await docs
        .find(filter)
        .sort({ at: -1, _id: -1 })
        .skip((current - 1) * size)
        .limit(size + 1)
        .toArray();
      return {
        entries: found.slice(0, size).map(({ _id, ...rest }) => ({ id: _id.toHexString(), ...rest })),
        page: current,
        hasNextPage: found.length > size,
      };
    },
  };
}

export async function ensureAuditIndexes(db: Db) {
  const docs = db.collection('auditLog');
  await docs.createIndex({ at: -1, _id: -1 });
  await docs.createIndex({ type: 1, at: -1 });
  await docs.createIndex({ actor: 1, at: -1 });
}
