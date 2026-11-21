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
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MongoClient, type Db } from 'mongodb';
import { inject } from 'vitest';
import { createAppCore, prepareDatabase, type AppCore, type AppCoreConfig } from '../index';
import { FakeClock } from './fake-clock';
import { InMemorySlackGateway } from './in-memory-slack';
import { MockLlm } from './mock-llm';
import { builtInDrivers } from '@/drivers';
import { createUploadsBackend } from '@/drivers/uploads';
import { createDuckDbResultCombiner } from '@/drivers/uploads/combine';
import type { DriverRegistry } from '../data-sources/driver';

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
  /** Data Source kinds. Default: the real built-in drivers plus Uploads over a temporary directory. */
  drivers?: DriverRegistry;
  /** Initial fake time. Default 2026-01-05T09:00:00Z (a Monday). */
  now?: Date;
}

export const DEFAULT_TEST_CONFIG: AppCoreConfig = {
  slackTeamId: 'T0TEST',
  adminSlackUserIds: [],
  encryptionKey: randomBytes(32).toString('base64'),
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
  const uploadsDir = await mkdtemp(path.join(tmpdir(), 'botley-uploads-'));
  const uploads = createUploadsBackend(uploadsDir);
  const drivers = options.drivers ?? { ...builtInDrivers, [uploads.kind.kind]: uploads.kind };
  const core = createAppCore({
    db,
    clock,
    slack,
    llm,
    drivers,
    config,
    uploadStorage: uploads.storage,
    combiner: createDuckDbResultCombiner(),
  });
  // As if an admin had chosen the mock model, so Prompts get answered; tests about choosing delete it.
  await db
    .collection<{ _id: string; [field: string]: unknown }>('appSettings')
    .insertOne({ _id: 'llm', provider: 'mock', model: 'mock-model', updatedBy: 'test', updatedAt: clock.now() });

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
      await rm(uploadsDir, { recursive: true, force: true });
    },
  };
}
