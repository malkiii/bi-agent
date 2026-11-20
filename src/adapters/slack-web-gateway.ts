import type { KnownBlock, ViewsOpenArguments, WebClient } from '@slack/web-api';
import type { SlackGateway } from '@/core';

type KnownBlocks = KnownBlock[];

/** SlackGateway over the Slack Web API (a bot-token WebClient, e.g. Bolt's `app.client`). */
export function createSlackWebGateway(client: WebClient): SlackGateway {
  return {
    async postMessage({ channel, threadTs, text, blocks }) {
      const res = await client.chat.postMessage({
        channel,
        text,
        ...(threadTs && { thread_ts: threadTs }),
        ...(blocks && { blocks: blocks as KnownBlocks }),
      });
      return { channel: res.channel ?? channel, ts: res.ts! };
    },

    async updateMessage({ channel, ts }, { text, blocks }) {
      await client.chat.update({ channel, ts, text, blocks: (blocks ?? []) as KnownBlocks });
    },

    async addReaction({ channel, ts }, emoji) {
      try {
        await client.reactions.add({ channel, timestamp: ts, name: emoji });
      } catch (error) {
        if ((error as { data?: { error?: string } }).data?.error !== 'already_reacted') throw error;
      }
    },

    async isBotInChannel(channel) {
      if (channel.startsWith('D')) return true;
      try {
        const info = await client.conversations.info({ channel });
        return info.channel?.is_member === true;
      } catch (error) {
        if ((error as { data?: { error?: string } }).data?.error === 'channel_not_found') return false;
        throw error;
      }
    },

    async openModal(triggerId, view) {
      await client.views.open({ trigger_id: triggerId, view: view as ViewsOpenArguments['view'] });
    },
  };
}
