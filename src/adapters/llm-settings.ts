/** LLM provider settings, parsed from the environment by src/server/config.ts. */
export const LLM_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter', 'groq', 'ollama'] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

export interface LlmCredentials {
  apiKey?: string;
  /** Ollama's API URL, ending in /api. */
  baseUrl?: string;
}

export interface LlmConfig {
  /** LLM_PROVIDER: pre-selected in admin settings until an admin chooses; null when unset. */
  defaultProvider: LlmProviderName | null;
  /** Every provider with configured credentials; admins choose among these. */
  credentials: Partial<Record<LlmProviderName, LlmCredentials>>;
}

/** The environment variable holding each provider's credential. */
export const LLM_CREDENTIAL_ENV: Record<LlmProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  ollama: 'OLLAMA_BASE_URL',
};
