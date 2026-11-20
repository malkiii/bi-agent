/**
 * LanguageModelProvider for production: the default provider and model come from the
 * environment (see src/server/config.ts); the App Core passes an admin's choice (stored in
 * settings) on each Prompt, limited to providers whose credentials are configured. Always builds provider instances; a bare model
 * string would route through the Vercel AI Gateway, which a self-hosted app must not use.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';
import type { LanguageModelProvider, LlmChoice } from '@/core';
import { LLM_PROVIDERS, type LlmCredentials, type LlmProviderName, type LlmSettings } from './llm-settings';

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

export function createLanguageModelProvider(settings: LlmSettings): LanguageModelProvider {
  const providers = LLM_PROVIDERS.filter((p) => settings.credentials[p]);
  const fallback: LlmChoice = { provider: settings.provider, model: settings.model };
  return {
    async getModel(choice = fallback) {
      const provider = providers.find((p) => p === choice.provider);
      if (!provider) throw new Error(`LLM provider "${choice.provider}" has no configured credentials`);
      return createLanguageModel(provider, choice.model, settings.credentials[provider]);
    },
    options: () => ({ default: fallback, providers }),
  };
}
