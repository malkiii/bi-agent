/**
 * Ports: everything the App Core needs from the outside world.
 * Production adapters live in `src/adapters`, test doubles in `src/core/testing`.
 */
import type { LanguageModel } from 'ai';

export interface Clock {
  now(): Date;
}

/** Resolves the active Vercel AI SDK model (provider + model come from settings). */
export interface LanguageModelProvider {
  getModel(): Promise<LanguageModel>;
}

export interface SlackMessageRef {
  channel: string;
  ts: string;
}

export interface SlackMessage {
  channel: string;
  /** Reply in this thread when set. */
  threadTs?: string;
  text: string;
  blocks?: unknown[];
}

export interface SlackFile {
  filename: string;
  title: string;
  content: Uint8Array;
  /** Image description for screen readers. */
  altText?: string;
}

/** Files shared together as one message, e.g. in an Answer's thread. */
export interface SlackFileUpload {
  channel: string;
  threadTs?: string;
  files: SlackFile[];
  /** Text of the message the files are shared with. */
  comment?: string;
}

/**
 * Outbound Slack operations. Grows as tickets need it;
 * add the method here and to both implementations.
 */
export interface SlackGateway {
  postMessage(message: SlackMessage): Promise<SlackMessageRef>;
  updateMessage(ref: SlackMessageRef, message: Omit<SlackMessage, 'channel' | 'threadTs'>): Promise<void>;
  addReaction(ref: SlackMessageRef, emoji: string): Promise<void>;
  isBotInChannel(channel: string): Promise<boolean>;
  /** Opens a modal in response to an interaction (`triggerId` expires 3 s after the click). `view` is a Block Kit modal. */
  openModal(triggerId: string, view: unknown): Promise<void>;
  /** Uploads files and shares them in the channel (thread) as one message. Needs the `files:write` scope. */
  uploadFiles(upload: SlackFileUpload): Promise<void>;
}
