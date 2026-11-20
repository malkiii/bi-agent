/**
 * App Core test harness: the real App Core over a real MongoDB database,
 * with a fake Clock, an in-memory SlackGateway and a scriptable mock LLM.
 *
 *   const h = await createTestHarness();
 *   await h.core.users.signIn(...);
 *   h.clock.advance(60_000);
 *   expect(h.slack.messages).toEqual(...);
 *   await h.close();
 *
 * Needs the `mongoUri` provided by test/global-setup.ts. Each harness gets its own
 * database (dropped on close), so test files can run in parallel.
 */
import { randomUUID } from 'node:crypto';
import { MongoClient, type Db } from 'mongodb';
import { inject } from 'vitest';
import { createAppCore, prepareDatabase, type AppCore, type AppCoreConfig } from '../index';
import { FakeClock } from './fake-clock';
import { InMemorySlackGateway } from './in-memory-slack';
import { MockLlm } from './mock-llm';

export { FakeClock } from './fake-clock';
export { InMemorySlackGateway } from './in-memory-slack';
export { MockLlm } from './mock-llm';

export interface TestHarness {
  core: AppCore;
  db: Db;
  clock: FakeClock;
  slack: InMemorySlackGateway;
  llm: MockLlm;
  config: AppCoreConfig;
  close(): Promise<void>;
}

export interface TestHarnessOptions {
  config?: Partial<AppCoreConfig>;
  /** Initial fake time. Default 2026-01-05T09:00:00Z (a Monday). */
  now?: Date;
}

export const DEFAULT_TEST_CONFIG: AppCoreConfig = {
  slackTeamId: 'T0TEST',
  adminSlackUserIds: [],
};

export async function createTestHarness(options: TestHarnessOptions = {}): Promise<TestHarness> {
  const client = new MongoClient(inject('mongoUri'));
  await client.connect();
  const db = client.db(`test_${randomUUID().replaceAll('-', '')}`);
  await prepareDatabase(db);

  const clock = new FakeClock(options.now ?? new Date('2026-01-05T09:00:00Z'));
  const slack = new InMemorySlackGateway();
  const llm = new MockLlm();
  const config = { ...DEFAULT_TEST_CONFIG, ...options.config };
  const core = createAppCore({ db, clock, slack, llm, config });

  return {
    core,
    db,
    clock,
    slack,
    llm,
    config,
    async close() {
      await db.dropDatabase();
      await client.close();
    },
  };
}
