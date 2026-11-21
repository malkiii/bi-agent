/** LLM provider settings, parsed from the environment by src/server/config.ts. */
export const LLM_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter', 'groq', 'ollama', 'openai-compatible'] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

export interface LlmCredentials {
  apiKey?: string;
  /** Ollama's API URL (ending in /api), or an OpenAI-compatible server's (usually ending in /v1). */
  baseUrl?: string;
}

export interface LlmConfig {
  /** LLM_PROVIDER: pre-selected in admin settings until an admin chooses; null when unset. */
  defaultProvider: LlmProviderName | null;
  /** Every provider with configured credentials; admins choose among these. */
  credentials: Partial<Record<LlmProviderName, LlmCredentials>>;
  /** Display names that replace the defaults (OPENAI_COMPATIBLE_NAME). */
  labels?: Partial<Record<LlmProviderName, string>>;
}

/** The environment variable that makes each provider available (its key, or its URL). */
export const LLM_CREDENTIAL_ENV: Record<LlmProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  ollama: 'OLLAMA_BASE_URL',
  'openai-compatible': 'OPENAI_COMPATIBLE_BASE_URL',
};

/** Each provider's display name in admin settings. */
export const LLM_PROVIDER_LABELS: Record<LlmProviderName, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  ollama: 'Ollama',
  'openai-compatible': 'OpenAI-compatible',
};
