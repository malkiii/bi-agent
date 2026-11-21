/**
 * LanguageModelProvider for production: offers the providers whose credentials are in the
 * environment (see src/server/config.ts); the App Core picks the active one. Always builds
 * provider instances; a bare model string would route through the Vercel AI Gateway, which a
 * self-hosted app must not use.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';
import type { LanguageModelProvider } from '@/core';
import { LLM_PROVIDERS, type LlmConfig, type LlmCredentials, type LlmProviderName } from './llm-settings';

export function createLanguageModel(provider: LlmProviderName, model: string, credentials: LlmCredentials = {}): LanguageModel {
  const { apiKey, baseUrl } = credentials;
  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey })(model);
    case 'openai':
      return createOpenAI({ apiKey })(model);
    case 'google':
      return createGoogle({ apiKey })(model);
    case 'openrouter':
      return createOpenRouter({ apiKey })(model);
    case 'groq':
      return createGroq({ apiKey })(model);
    case 'ollama':
      return createOllama({ baseURL: baseUrl })(model);
  }
}

export function createLanguageModelProvider(config: LlmConfig): LanguageModelProvider {
  const providers = LLM_PROVIDERS.filter((p) => config.credentials[p]);
  return {
    configuredProviders: () => providers,
    defaultChoice: () => config.defaultChoice,
    async getModel({ provider, model }) {
      const name = providers.find((p) => p === provider);
      if (!name) throw new Error(`The LLM provider "${provider}" has no configured credentials.`);
      return createLanguageModel(name, model, config.credentials[name]);
    },
  };
}
