import { randomUUID } from 'node:crypto';
import { expect, inject, test } from 'vitest';
import { startWorker } from './worker';

test('worker connects to Mongo and logs readiness', async () => {
  const lines: string[] = [];
  const logger = { info: (msg: string) => lines.push(msg), error: (msg: string) => lines.push(msg) };

  const worker = await startWorker({
    config: {
      mongoUrl: inject('mongoUri'),
      mongoDb: `test_${randomUUID().replaceAll('-', '')}`,
      core: { slackTeamId: 'T0TEAM', adminSlackUserIds: [], encryptionKey: 'a'.repeat(64) },
      llm: null,
    },
    logger,
  });

  try {
    expect(lines).toContainEqual(expect.stringMatching(/worker ready/i));
  } finally {
    await worker.db.dropDatabase();
    await worker.stop();
  }
});
