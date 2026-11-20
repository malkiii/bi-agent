import type { LanguageModelProvider, SlackGateway } from '@/core';

/**
 * Placeholders until the real adapters land (Slack Web API gateway, LLM settings).
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
};

export const unconfiguredLlm: LanguageModelProvider = {
  getModel: async () => notYet('LanguageModelProvider'),
};
