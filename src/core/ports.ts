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

/**
 * Outbound Slack operations. Grows as tickets need it
 * (file uploads, modals, ...); add the method here and to both implementations.
 */
export interface SlackGateway {
  postMessage(message: SlackMessage): Promise<SlackMessageRef>;
  updateMessage(ref: SlackMessageRef, message: Omit<SlackMessage, 'channel' | 'threadTs'>): Promise<void>;
  addReaction(ref: SlackMessageRef, emoji: string): Promise<void>;
  isBotInChannel(channel: string): Promise<boolean>;
}
