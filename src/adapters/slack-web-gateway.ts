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

    async removeReaction({ channel, ts }, emoji) {
      try {
        await client.reactions.remove({ channel, timestamp: ts, name: emoji });
      } catch (error) {
        if ((error as { data?: { error?: string } }).data?.error !== 'no_reaction') throw error;
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

    async uploadFiles({ channel, threadTs, files, comment }) {
      const file_uploads = files.map((f) => ({
        file: Buffer.from(f.content),
        filename: f.filename,
        title: f.title,
        ...(f.altText && { alt_text: f.altText }),
      }));
      const args = {
        channel_id: channel,
        file_uploads,
        ...(threadTs && { thread_ts: threadTs }),
        ...(comment && { initial_comment: comment }),
      };
      // The overloads tie thread_ts to channel_id in ways a spread can't express.
      await client.filesUploadV2(args as Parameters<WebClient['filesUploadV2']>[0]);
    },

    async listChannels() {
      const channels: { id: string; name: string }[] = [];
      let cursor: string | undefined;
      do {
        const res = await client.users.conversations({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          ...(cursor && { cursor }),
        });
        for (const c of res.channels ?? []) if (c.id && c.name) channels.push({ id: c.id, name: c.name });
        cursor = res.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return channels.sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
