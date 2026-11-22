/**
 * Slack bot use cases: answer a Prompt posted in Slack (an @mention in a channel, or any DM)
 * in its thread, and open the "Show query" modal. Transport details (Bolt, Socket Mode,
 * event filtering) stay in the worker's adapter; everything Slack sees goes through
 * the SlackGateway port, so these behaviours are tested with the in-memory gateway.
 */
import type { Db } from 'mongodb';
import type { Conversations } from '../conversations/conversations';
import { AppError } from '../errors';
import { renderChartPng } from '../charts/png';
import { fileBaseName, tableFileName, tableToCsv, tableToXlsx } from '../files/table-files';
import type { Clock, SlackFile, SlackGateway, SlackMessageRef } from '../ports';
import {
  type ThreadUpload,
  PLACEHOLDER_TEXT,
  cleanPromptText,
  renderAnswer,
  renderFailure,
  renderProgress,
  renderQueryModal,
  type RenderedMessage,
} from './render';

export interface SlackPrompt {
  /** Slack user ID of the poster. */
  userId: string;
  channel: string;
  /** The message's own timestamp. */
  ts: string;
  /** Set when the message was posted inside a thread. */
  threadTs?: string;
  /** Raw Slack message text (mentions and markup included). */
  text: string;
  /** The bot's user ID, so its own mention is removed from the Prompt. */
  botUserId?: string;
}

export interface SlackBot {
  /**
   * 👀 on the message, a placeholder reply in the thread that shows progress, then the Answer
   * edited into the placeholder and 👀 swapped for ✅ (for ❌ and a readable error on failure). The thread is the
   * Conversation; the poster becomes a Participant. Duplicate deliveries are ignored.
   */
  handlePrompt(prompt: SlackPrompt): Promise<void>;
  /** "Show query" button: `value` is the button's value (the Answer message id). */
  showQuery(input: { triggerId: string; value: string }): Promise<void>;
}

interface Deps {
  db: Db;
  clock: Clock;
  slack: SlackGateway;
  conversations: Conversations;
  /** The web app's URL, for the "Open in dashboard" link; no link without it. */
  appUrl?: string;
  onError?: (error: unknown) => void;
}

const EMPTY_PROMPT_HINT = "Hi! Ask me a question about your data, e.g. _how many orders did we ship last week by region?_";
const UNEXPECTED_ERROR = 'Sorry, something went wrong while answering. Please try again, or ask an admin to check the logs.';

interface SlackEventDoc {
  _id: string;
  receivedAt: Date;
}

const UPLOAD_FAILED =
  ':warning: I could not attach the chart or table files to this thread. Ask an admin to check that the bot has the `files:write` scope.';

export function createSlackBot({ db, clock, slack, conversations, appUrl, onError }: Deps): SlackBot {
  const events = db.collection<SlackEventDoc>('slackEvents');

  /** True the first time this message is seen (Socket Mode may redeliver events). */
  async function firstDelivery(channel: string, ts: string): Promise<boolean> {
    try {
      await events.insertOne({ _id: `${channel}:${ts}`, receivedAt: clock.now() });
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) return false;
      throw error;
    }
  }

  /** Chart PNGs and long-table files, one message per Result Block, after the Answer. Never throws. */
  async function uploadToThread(uploads: ThreadUpload[], channel: string, threadTs: string) {
    let failed = false;
    for (const upload of uploads) {
      try {
        await slack.uploadFiles({ channel, threadTs, files: await filesFor(upload) });
      } catch (error) {
        onError?.(error);
        failed = true;
      }
    }
    if (failed) await slack.postMessage({ channel, threadTs, text: UPLOAD_FAILED }).catch(onError);
  }

  return {
    async handlePrompt(prompt) {
      if (!(await firstDelivery(prompt.channel, prompt.ts))) return;
      const message: SlackMessageRef = { channel: prompt.channel, ts: prompt.ts };
      const threadTs = prompt.threadTs ?? prompt.ts;
      const text = cleanPromptText(prompt.text, prompt.botUserId);
      if (!text) {
        await slack.postMessage({ channel: prompt.channel, threadTs, text: EMPTY_PROMPT_HINT });
        return;
      }

      await slack.addReaction(message, 'eyes').catch(onError);
      const placeholder = await slack.postMessage({ channel: prompt.channel, threadTs, text: PLACEHOLDER_TEXT });

      // Progress edits run one after another, and the final edit waits for them.
      let edits = Promise.resolve();
      let lastLabel = '';
      const edit = (rendered: RenderedMessage) => {
        edits = edits.then(() => slack.updateMessage(placeholder, rendered)).catch(onError);
        return edits;
      };

      let failure: string | undefined;
      try {
        const conversation = await conversations.findOrStartSlack(prompt.userId, { channel: prompt.channel, threadTs });
        const { answer, answerMessageId } = await conversations.answerPrompt(prompt.userId, conversation.id, text, {
          onEvent: (event) => {
            if (event.type !== 'progress' || event.label === lastLabel) return;
            lastLabel = event.label;
            void edit(renderProgress(event.label));
          },
        });
        if (answer.status === 'failed') failure = answer.error;
        const dashboardUrl = appUrl ? `${appUrl.replace(/\/+$/, '')}/chat/fork/${conversation.id}` : undefined;
        const { uploads, ...rendered } = renderAnswer(answer, { answerId: answerMessageId, dashboardUrl });
        await edit(rendered);
        await uploadToThread(uploads, prompt.channel, threadTs);
      } catch (error) {
        if (!(error instanceof AppError)) onError?.(error);
        failure = error instanceof AppError ? error.message : UNEXPECTED_ERROR;
        await edit(renderFailure(failure));
      }
      // 👀 gives way to the outcome: ✅ answered, ❌ failed.
      await slack.removeReaction(message, 'eyes').catch(onError);
      await slack.addReaction(message, failure === undefined ? 'white_check_mark' : 'x').catch(onError);
    },

    async showQuery({ triggerId, value }) {
      const answer = await conversations.getAnswer(value);
      await slack.openModal(triggerId, renderQueryModal(answer));
    },
  };
}

async function filesFor(upload: ThreadUpload): Promise<SlackFile[]> {
  if (upload.kind === 'chart') {
    const chart = upload.block;
    const title = chart.title ?? 'Chart';
    const filename = `${fileBaseName(chart) || 'chart'}.png`;
    return [{ filename, title, content: await renderChartPng(chart), altText: `${chart.kind} chart: ${title}` }];
  }
  const table = upload.block;
  const title = table.title ?? 'Full table';
  return [
    { filename: tableFileName(table, 'csv'), title: `${title} (CSV)`, content: new TextEncoder().encode(tableToCsv(table)) },
    { filename: tableFileName(table, 'xlsx'), title: `${title} (XLSX)`, content: await tableToXlsx(table) },
  ];
}

export async function ensureSlackBotIndexes(db: Db) {
  // Remember delivered events for a day; redeliveries arrive within minutes.
  await db.collection('slackEvents').createIndex({ receivedAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });
}
