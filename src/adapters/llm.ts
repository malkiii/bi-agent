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
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';
import type { LanguageModelProvider } from '@/core';
import { listProviderModels } from './llm-models';
import { LLM_PROVIDER_LABELS, LLM_PROVIDERS, type LlmConfig, type LlmCredentials, type LlmProviderName } from './llm-settings';

/**
 * Models each provider answers with until an admin chooses one, best first; the first that the
 * provider lists wins. When none is listed, the first of its models in id order is used.
 */
const PREFERRED_MODELS: Partial<Record<LlmProviderName, readonly string[]>> = {
  anthropic: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
  openai: ['gpt-5', 'gpt-5-mini', 'gpt-4.1'],
  google: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  openrouter: ['anthropic/claude-sonnet-5.5', 'openai/gpt-5'],
  groq: ['llama-3.3-70b-versatile'],
};

export function createLanguageModel(
  provider: LlmProviderName,
  model: string,
  credentials: LlmCredentials = {},
  fetchFn: typeof fetch = fetch,
): LanguageModel {
  const { apiKey, baseUrl } = credentials;
  const fetch = fetchFn;
  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey, fetch })(model);
    case 'openai':
      return createOpenAI({ apiKey, fetch })(model);
    case 'google':
      return createGoogle({ apiKey, fetch })(model);
    case 'openrouter':
      return createOpenRouter({ apiKey, fetch })(model);
    case 'groq':
      return createGroq({ apiKey, fetch })(model);
    case 'ollama':
      return createOllama({ baseURL: baseUrl, fetch })(model);
    case 'openai-compatible':
      if (!baseUrl) throw new Error('The OpenAI-compatible provider needs a base URL (OPENAI_COMPATIBLE_BASE_URL).');
      // Chat Completions, which these servers implement (not OpenAI's Responses API).
      // includeUsage: streamed answers report their token usage for the audit log.
      return createOpenAICompatible({ name: 'openai-compatible', baseURL: baseUrl, apiKey, includeUsage: true, fetch }).chatModel(model);
  }
}

const RETRY_DEFAULT_MS = 60_000;

export function createLanguageModelProvider(config: LlmConfig, fetchFn: typeof fetch = fetch): LanguageModelProvider {
  const providers = LLM_PROVIDERS.filter((p) => config.credentials[p]);
  const configured = (provider: string) => {
    const name = providers.find((p) => p === provider);
    if (!name) throw new Error(`The LLM provider "${provider}" has no configured credentials.`);
    return name;
  };
  /** Defaults found so far; a failed or empty lookup is retried after RETRY_DEFAULT_MS. */
  const defaults = new Map<LlmProviderName, string>();
  const failedAt = new Map<LlmProviderName, number>();
  return {
    configuredProviders: () => providers,
    async defaultModel(provider) {
      const name = configured(provider);
      const known = defaults.get(name);
      if (known) return known;
      const preferred = PREFERRED_MODELS[name] ?? [];
      // A provider that failed recently isn't asked on every Prompt: guess until the retry.
      if (Date.now() - (failedAt.get(name) ?? -Infinity) < RETRY_DEFAULT_MS) return preferred[0] ?? null;
      let ids: string[];
      try {
        ids = (await listProviderModels(name, config.credentials[name] ?? {}, fetchFn)).map((m) => m.id).sort();
      } catch {
        ids = [];
      }
      const model = preferred.find((id) => ids.includes(id)) ?? ids[0] ?? null;
      if (model) defaults.set(name, model);
      else failedAt.set(name, Date.now());
      return model ?? preferred[0] ?? null;
    },
    providerLabel: (provider) =>
      config.labels?.[provider as LlmProviderName] ?? LLM_PROVIDER_LABELS[provider as LlmProviderName] ?? provider,
    async listModels(provider) {
      const name = configured(provider);
      return listProviderModels(name, config.credentials[name] ?? {}, fetchFn);
    },
    async getModel({ provider, model }) {
      const name = configured(provider);
      return createLanguageModel(name, model, config.credentials[name], fetchFn);
    },
  };
}
