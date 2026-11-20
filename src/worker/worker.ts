import type { Db } from 'mongodb';
import type { AppCore } from '@/core';
import { bootstrap, type Logger } from '@/server/bootstrap';
import type { ServerConfig } from '@/server/config';

export interface Worker {
  core: AppCore;
  db: Db;
  stop(): Promise<void>;
}

/**
 * The long-running worker process (ADR 0004). Today it only connects to Mongo;
 * Slack Socket Mode and the scheduler attach here in later tickets.
 */
export async function startWorker({ config, logger }: { config: ServerConfig; logger: Logger }): Promise<Worker> {
  const { core, db, client } = await bootstrap(config);
  logger.info(`worker ready (mongo db "${config.mongoDb}")`);
  return {
    core,
    db,
    async stop() {
      await client.close();
      logger.info('worker stopped');
    },
  };
}
