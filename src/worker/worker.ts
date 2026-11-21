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

/** How often the worker looks for due scheduled work (Report Runs). */
export const SCHEDULER_TICK_MS = 30_000;

/**
 * The long-running worker process (ADR 0004): connects to Mongo, runs the scheduler (jobs in
 * Mongo) and, when SLACK_BOT_TOKEN and SLACK_APP_TOKEN are set, connects to Slack in Socket Mode.
 */
export async function startWorker({ config, logger }: { config: ServerConfig; logger: Logger }): Promise<Worker> {
  const { core, db, client } = await bootstrap(config);
  let slackApp: SlackApp | undefined;
  if (config.slack?.appToken) {
    slackApp = await startSlackApp({ botToken: config.slack.botToken, appToken: config.slack.appToken, core, logger });
  } else {
    logger.info('Slack is not configured (SLACK_BOT_TOKEN, SLACK_APP_TOKEN); Socket Mode is off');
  }
  const scheduler = startSchedulerLoop(core, logger);
  logger.info(`worker ready (mongo db "${config.mongoDb}")`);
  return {
    core,
    db,
    async stop() {
      await scheduler.stop();
      await slackApp?.stop();
      await client.close();
      logger.info('worker stopped');
    },
  };
}

/** Calls `core.scheduler.runDue()` every tick, never two at once; `stop` waits for the current tick. */
function startSchedulerLoop(core: AppCore, logger: Logger): { stop(): Promise<void> } {
  let current: Promise<void> | null = null;
  const tick = () => {
    if (current) return;
    current = core.scheduler
      .runDue()
      .then(
        (ran) => {
          if (ran > 0) logger.info(`scheduler ran ${ran} job(s)`);
        },
        (error: unknown) => logger.error(`scheduler failed: ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => {
        current = null;
      });
  };
  const timer = setInterval(tick, SCHEDULER_TICK_MS);
  tick();
  return {
    async stop() {
      clearInterval(timer);
      await current;
    },
  };
}
