import type { SlackChannel, SlackFileUpload, SlackGateway, SlackMessage, SlackMessageRef } from '../ports';

export interface RecordedMessage extends SlackMessage {
  ts: string;
  /** Earlier versions of this message, oldest first, when it has been updated. */
  history: Omit<SlackMessage, 'channel' | 'threadTs'>[];
}

export interface RecordedReaction extends SlackMessageRef {
  emoji: string;
}

/** Records everything the App Core sends to Slack. Assert on `messages`, `reactions` and `modals`. */
export class InMemorySlackGateway implements SlackGateway {
  readonly messages: RecordedMessage[] = [];
  readonly reactions: RecordedReaction[] = [];
  readonly modals: { triggerId: string; view: unknown }[] = [];
  readonly uploads: SlackFileUpload[] = [];
  /** Set to make `uploadFiles` reject, like Slack without the `files:write` scope. */
  failUploads = false;
  /** Channels the bot is a member of (DM channel IDs starting with "D" always count). */
  readonly botChannels = new Set<string>();
  /** Names `listChannels` reports for `botChannels` (default: the id). */
  readonly channelNames = new Map<string, string>();
  private seq = 0;

  async postMessage(message: SlackMessage): Promise<SlackMessageRef> {
    const ts = `1700000000.${String(++this.seq).padStart(6, '0')}`;
    this.messages.push({ ...message, ts, history: [] });
    return { channel: message.channel, ts };
  }

  async updateMessage(ref: SlackMessageRef, update: Omit<SlackMessage, 'channel' | 'threadTs'>): Promise<void> {
    const message = this.find(ref);
    message.history.push({ text: message.text, blocks: message.blocks });
    message.text = update.text;
    message.blocks = update.blocks;
  }

  async addReaction(ref: SlackMessageRef, emoji: string): Promise<void> {
    this.reactions.push({ ...ref, emoji });
  }

  async isBotInChannel(channel: string): Promise<boolean> {
    return channel.startsWith('D') || this.botChannels.has(channel);
  }

  async openModal(triggerId: string, view: unknown): Promise<void> {
    this.modals.push({ triggerId, view });
  }

  async uploadFiles(upload: SlackFileUpload): Promise<void> {
    if (this.failUploads) throw new Error('missing_scope');
    this.uploads.push(upload);
  }

  async listChannels(): Promise<SlackChannel[]> {
    return [...this.botChannels].map((id) => ({ id, name: this.channelNames.get(id) ?? id }));
  }

  /** Messages posted in one thread (or top-level in a channel when threadTs is omitted). */
  thread(channel: string, threadTs?: string): RecordedMessage[] {
    return this.messages.filter((m) => m.channel === channel && m.threadTs === threadTs);
  }

  private find(ref: SlackMessageRef): RecordedMessage {
    const message = this.messages.find((m) => m.channel === ref.channel && m.ts === ref.ts);
    if (!message) throw new Error(`No message ${ref.channel}/${ref.ts} was posted`);
    return message;
  }
}
