/**
 * Slack in Socket Mode (ADR 0004): a Bolt app that turns Slack events into App Core calls.
 * Business rules stay in `core.slackBot`; this file only filters events and maps payloads.
 */
import { App, LogLevel } from '@slack/bolt';
import { OPEN_IN_DASHBOARD_ACTION_ID, SHOW_QUERY_ACTION_ID, type AppCore, type SlackPrompt } from '@/core';
import type { Logger } from '@/server/bootstrap';

/** The fields of an `app_mention` / `message` event this adapter reads. */
export interface IncomingSlackMessage {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
}

/** An @mention in a channel (or group DM). Returns null for events from bots. */
export function promptFromMention(event: IncomingSlackMessage, botUserId?: string): SlackPrompt | null {
  if (event.bot_id || !event.user || event.user === botUserId || !event.channel || !event.ts) return null;
  return toPrompt(event, event.user, event.channel, event.ts, botUserId);
}

/**
 * A message in the bot's DM. Every plain message counts, no mention needed. Edits, joins,
 * bot messages and messages in other kinds of channels are ignored (channels go through
 * `app_mention`, so thread chatter without a mention never reaches the bot).
 */
export function promptFromDirectMessage(event: IncomingSlackMessage, botUserId?: string): SlackPrompt | null {
  if (event.channel_type !== 'im' || event.subtype !== undefined) return null;
  return promptFromMention(event, botUserId);
}

function toPrompt(event: IncomingSlackMessage, user: string, channel: string, ts: string, botUserId?: string): SlackPrompt {
  return {
    userId: user,
    channel,
    ts,
    text: event.text ?? '',
    ...(event.thread_ts && { threadTs: event.thread_ts }),
    ...(botUserId && { botUserId }),
  };
}

export interface SlackApp {
  stop(): Promise<void>;
}

export async function startSlackApp({
  botToken,
  appToken,
  core,
  logger,
}: {
  botToken: string;
  appToken: string;
  core: AppCore;
  logger: Logger;
}): Promise<SlackApp> {
  const app = new App({ token: botToken, appToken, socketMode: true, logLevel: LogLevel.WARN });
  const botUserId = (await app.client.auth.test()).user_id;

  const answer = (prompt: SlackPrompt | null) => {
    if (!prompt) return;
    // Don't block Bolt's listener; the App Core reports its own failures to Slack.
    core.slackBot.handlePrompt(prompt).catch((error: unknown) => logger.error(`Slack prompt failed: ${describe(error)}`));
  };

  app.event('app_mention', async ({ event }) => answer(promptFromMention(event as IncomingSlackMessage, botUserId)));
  app.message(async ({ message }) => answer(promptFromDirectMessage(message as IncomingSlackMessage, botUserId)));

  app.action(SHOW_QUERY_ACTION_ID, async ({ ack, body, action }) => {
    await ack();
    const value = 'value' in action ? action.value : undefined;
    const triggerId = 'trigger_id' in body ? body.trigger_id : undefined;
    if (!value || !triggerId) return;
    await core.slackBot.showQuery({ triggerId, value }).catch((error: unknown) => logger.error(`Show query failed: ${describe(error)}`));
  });

  // "Open in dashboard" is a link button: the browser opens the URL, Slack still expects an ack.
  app.action(OPEN_IN_DASHBOARD_ACTION_ID, async ({ ack }) => {
    await ack();
  });

  app.error(async (error) => logger.error(`Slack error: ${describe(error)}`));

  await app.start();
  logger.info(`Slack connected in Socket Mode as ${botUserId ?? 'unknown bot'}`);
  return {
    async stop() {
      await app.stop();
    },
  };
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
