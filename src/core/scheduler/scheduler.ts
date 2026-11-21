/**
 * The scheduler: timed jobs stored in Mongo (collection `jobs`), run by the worker.
 * App Core modules register a handler per job kind and set when each target runs next;
 * the worker calls `runDue()` on a timer, and tests call it after moving the fake Clock.
 *
 *   jobs.handle('report', async (reportId) => { ...; return nextRunAt ?? null });
 *   await jobs.set('report', reportId, nextRunAt);   // null removes the job
 *   await scheduler.runDue();                        // runs every job whose time has come
 *
 * A job is claimed with a lease before it runs, so several workers never run it twice.
 * Missed times are not caught up: a job that was due long ago runs once, then its handler
 * says when it runs next.
 */
import type { Db } from 'mongodb';
import type { Clock } from '../ports';

/** Runs one job; returns when it runs next, or null to remove it. */
export type JobHandler = (targetId: string, job: { runAt: Date }) => Promise<Date | null>;

export interface Scheduler {
  /** Runs every due job once, oldest first; returns how many ran. */
  runDue(): Promise<number>;
}

/** What App Core modules use to schedule their own work. */
export interface Jobs {
  handle(kind: string, handler: JobHandler): void;
  /** Schedules `targetId` to run at `runAt`, replacing any earlier time; null removes it. */
  set(kind: string, targetId: string, runAt: Date | null): Promise<void>;
}

interface JobDoc {
  _id: string;
  kind: string;
  targetId: string;
  runAt: Date;
  /** Claimed until then; the epoch when free. */
  lockedUntil: Date;
}

/** How long a claimed job may run before another worker may take it over. */
export const JOB_LEASE_MS = 15 * 60_000;
/** When a handler throws, the job is tried again this much later. */
export const JOB_RETRY_MS = 5 * 60_000;
const FREE = new Date(0);
const MAX_JOBS_PER_TICK = 100;

export function createScheduler({ db, clock, onError }: { db: Db; clock: Clock; onError?: (error: unknown) => void }): {
  scheduler: Scheduler;
  jobs: Jobs;
} {
  const collection = db.collection<JobDoc>('jobs');
  const handlers = new Map<string, JobHandler>();
  const idOf = (kind: string, targetId: string) => `${kind}:${targetId}`;

  async function claim(): Promise<JobDoc | null> {
    const now = clock.now();
    return collection.findOneAndUpdate(
      { kind: { $in: [...handlers.keys()] }, runAt: { $lte: now }, lockedUntil: { $lte: now } },
      { $set: { lockedUntil: new Date(now.getTime() + JOB_LEASE_MS) } },
      { sort: { runAt: 1 }, returnDocument: 'after' },
    );
  }

  return {
    jobs: {
      handle(kind, handler) {
        handlers.set(kind, handler);
      },

      async set(kind, targetId, runAt) {
        if (!runAt) {
          await collection.deleteOne({ _id: idOf(kind, targetId) });
          return;
        }
        await collection.updateOne(
          { _id: idOf(kind, targetId) },
          { $set: { kind, targetId, runAt }, $setOnInsert: { lockedUntil: FREE } },
          { upsert: true },
        );
      },
    },

    scheduler: {
      async runDue() {
        let ran = 0;
        for (let job = await claim(); job && ran < MAX_JOBS_PER_TICK; job = await claim()) {
          ran++;
          const lease = job.lockedUntil;
          let next: Date | null;
          try {
            next = await handlers.get(job.kind)!(job.targetId, { runAt: job.runAt });
          } catch (error) {
            onError?.(error);
            next = new Date(clock.now().getTime() + JOB_RETRY_MS);
          }
          // Only the holder of the lease reschedules; a job taken over after its lease expired is left alone.
          if (next) {
            await collection.updateOne({ _id: job._id, lockedUntil: lease }, { $set: { runAt: next, lockedUntil: FREE } });
          } else {
            await collection.deleteOne({ _id: job._id, lockedUntil: lease });
          }
        }
        return ran;
      },
    },
  };
}

export async function ensureJobIndexes(db: Db) {
  await db.collection('jobs').createIndex({ runAt: 1 });
}
