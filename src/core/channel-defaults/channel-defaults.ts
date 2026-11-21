/**
 * Channel Defaults: the Data Sources the agent prefers for Prompts in one Slack channel.
 * Admins manage them; the Conversations service reads them for every Slack Prompt. The agent
 * keeps to these Data Sources while at least one of them can be queried (see `createAgentCatalog`).
 */
import type { Db } from 'mongodb';
import { existingDataSourceIds, type DataSources } from '../data-sources/data-sources';
import { ValidationError } from '../errors';
import type { Clock, SlackChannel, SlackGateway } from '../ports';
import type { Users } from '../users/users';

export interface ChannelDefault {
  /** Slack channel id, e.g. C0123ABCD. */
  channel: string;
  /** The channel's name when it was set (for display); the id when Slack didn't say. */
  channelName: string;
  dataSourceIds: string[];
  updatedBy: string;
  updatedAt: Date;
}

export interface ChannelDefaults {
  /** Admin only. Sorted by channel name. */
  list(actorSlackUserId: string): Promise<ChannelDefault[]>;
  /**
   * Admin only: replaces the Channel Default of `channel`. ValidationError for a malformed
   * channel id, no Data Sources or an unknown one.
   */
  set(actorSlackUserId: string, channel: string, dataSourceIds: readonly string[]): Promise<ChannelDefault>;
  /** Admin only. No-op when the channel has none. */
  remove(actorSlackUserId: string, channel: string): Promise<void>;
  /** Admin only: the channels the bot is in, to choose from. */
  slackChannels(actorSlackUserId: string): Promise<SlackChannel[]>;
  /** The Data Source ids for Prompts in `channel`, if it has a Channel Default. No access check. */
  forChannel(channel: string): Promise<string[] | undefined>;
}

interface ChannelDefaultDoc {
  _id: string;
  channelName: string;
  dataSourceIds: string[];
  updatedBy: string;
  updatedAt: Date;
}

/** Public (C) and private (G) channel ids. DMs have no Channel Default. */
const CHANNEL_ID = /^[CG][A-Z0-9]{2,}$/;

export function createChannelDefaults({
  db,
  clock,
  users,
  dataSources,
  slack,
}: {
  db: Db;
  clock: Clock;
  users: Users;
  dataSources: DataSources;
  slack: SlackGateway;
}): ChannelDefaults {
  const docs = db.collection<ChannelDefaultDoc>('channelDefaults');

  async function channelName(channel: string): Promise<string> {
    try {
      return (await slack.listChannels()).find((c) => c.id === channel)?.name ?? channel;
    } catch {
      return channel; // Slack is not configured or lacks the scope; the id still works.
    }
  }

  return {
    async list(actor) {
      await users.requireAdmin(actor);
      const found = await docs.find().sort({ channelName: 1, _id: 1 }).toArray();
      return found.map(toChannelDefault);
    },

    async set(actor, rawChannel, dataSourceIds) {
      await users.requireAdmin(actor);
      const channel = rawChannel.trim();
      if (!CHANNEL_ID.test(channel)) {
        throw new ValidationError('Choose a Slack channel.', { channel: 'Not a channel id, e.g. C0123ABCD.' });
      }
      const ids = await existingDataSourceIds(dataSources, dataSourceIds);
      if (ids.length === 0) throw new ValidationError('Choose at least one Data Source.', { dataSourceIds: 'Required' });
      const doc: ChannelDefaultDoc = {
        _id: channel,
        channelName: await channelName(channel),
        dataSourceIds: ids,
        updatedBy: actor,
        updatedAt: clock.now(),
      };
      await docs.replaceOne({ _id: channel }, doc, { upsert: true });
      return toChannelDefault(doc);
    },

    async remove(actor, channel) {
      await users.requireAdmin(actor);
      await docs.deleteOne({ _id: channel });
    },

    async slackChannels(actor) {
      await users.requireAdmin(actor);
      return slack.listChannels();
    },

    async forChannel(channel) {
      return (await docs.findOne({ _id: channel }))?.dataSourceIds;
    },
  };
}

function toChannelDefault({ _id, ...rest }: ChannelDefaultDoc): ChannelDefault {
  return { channel: _id, ...rest };
}
