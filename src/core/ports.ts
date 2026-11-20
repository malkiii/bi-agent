/**
 * Ports: everything the App Core needs from the outside world.
 * Production adapters live in `src/adapters`, test doubles in `src/core/testing`.
 */
import type { LanguageModel } from 'ai';

export interface Clock {
  now(): Date;
}

/** An LLM provider name (e.g. `anthropic`, `openai`) and one of its model IDs. */
export interface LlmChoice {
  provider: string;
  model: string;
}

/** What the environment configured: the default choice and every provider with credentials. */
export interface LlmOptions {
  default: LlmChoice | null;
  providers: readonly string[];
}

/**
 * Builds Vercel AI SDK models. The App Core passes the active choice (admin override from
 * settings, else the environment default) on every Prompt; without one, the default is used.
 */
export interface LanguageModelProvider {
  getModel(choice?: LlmChoice): Promise<LanguageModel>;
  /** The providers admins may switch among. Absent: only the default, no switching. */
  options?(): LlmOptions;
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
