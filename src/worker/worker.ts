import type { Db } from 'mongodb';
import type { AppCore } from '@/core';
import { bootstrap, type Logger } from '@/server/bootstrap';
import type { ServerConfig } from '@/server/config';
import { startSlackApp, type SlackApp } from './slack-app';

export interface Worker {
  core: AppCore;
  db: Db;
  stop(): Promise<void>;
}

/**
 * The long-running worker process (ADR 0004): connects to Mongo and, when SLACK_BOT_TOKEN and
 * SLACK_APP_TOKEN are set, to Slack in Socket Mode. The scheduler attaches here in a later ticket.
 */
export async function startWorker({ config, logger }: { config: ServerConfig; logger: Logger }): Promise<Worker> {
  const { core, db, client } = await bootstrap(config);
  let slackApp: SlackApp | undefined;
  if (config.slack?.appToken) {
    slackApp = await startSlackApp({ botToken: config.slack.botToken, appToken: config.slack.appToken, core, logger });
  } else {
    logger.info('Slack is not configured (SLACK_BOT_TOKEN, SLACK_APP_TOKEN); Socket Mode is off');
  }
  logger.info(`worker ready (mongo db "${config.mongoDb}")`);
  return {
    core,
    db,
    async stop() {
      await slackApp?.stop();
      await client.close();
      logger.info('worker stopped');
    },
  };
}
