import type { LanguageModelProvider, SlackGateway } from '@/core';

/**
 * Placeholders when an adapter is not configured (no Slack bot token, no LLM credentials).
 * They fail loudly if anything tries to use them.
 */
function notYet(what: string): never {
  throw new Error(`${what} is not configured yet`);
}

export const unconfiguredSlack: SlackGateway = {
  postMessage: async () => notYet('SlackGateway'),
  updateMessage: async () => notYet('SlackGateway'),
  addReaction: async () => notYet('SlackGateway'),
  isBotInChannel: async () => notYet('SlackGateway'),
  openModal: async () => notYet('SlackGateway'),
  uploadFiles: async () => notYet('SlackGateway'),
  listChannels: async () => notYet('SlackGateway'),
};

/** No LLM credentials in the environment: nothing to choose, and Answers fail. */
export const unconfiguredLlm: LanguageModelProvider = {
  configuredProviders: () => [],
  defaultProvider: () => null,
  listModels: async () => notYet('LanguageModelProvider'),
  getModel: async () => notYet('LanguageModelProvider'),
};
