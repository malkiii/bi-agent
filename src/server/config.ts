import { z } from 'zod';
import type { AppCoreConfig } from '@/core';
import { parseEncryptionKey } from '@/core/secret-box';
import { LLM_CREDENTIAL_ENV, LLM_PROVIDERS, type LlmCredentials, type LlmProviderName, type LlmSettings } from '@/adapters/llm-settings';

const isEncryptionKey = (text: string) => {
  try {
    parseEncryptionKey(text);
    return true;
  } catch {
    return false;
  }
};

/**
 * Process configuration shared by `web` and `worker`, read from the environment.
 * Auth.js reads its own AUTH_* variables directly; see .env.example.
 */
export interface ServerConfig {
  mongoUrl: string;
  mongoDb: string;
  core: AppCoreConfig;
  /** The default LLM provider and model; null when LLM_PROVIDER is unset (Answers then fail with a friendly error). */
  llm: LlmSettings | null;
}

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/api';

const required = (name: string) => z.string({ error: `${name} is required` }).trim().min(1, `${name} is required`);
const optional = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || undefined);

const schema = z
  .object({
    MONGO_URL: required('MONGO_URL'),
    MONGO_DB: z.string().trim().min(1).default('botley'),
    SLACK_TEAM_ID: required('SLACK_TEAM_ID'),
    ADMIN_SLACK_USER_IDS: z.string().default(''),
    ENCRYPTION_KEY: required('ENCRYPTION_KEY').refine(isEncryptionKey, 'ENCRYPTION_KEY must be 32 bytes, base64- or hex-encoded (openssl rand -base64 32)'),
    LLM_PROVIDER: optional.pipe(
      z.enum(LLM_PROVIDERS, { error: `LLM_PROVIDER must be one of ${LLM_PROVIDERS.join(', ')}` }).optional(),
    ),
    LLM_MODEL: optional,
    ANTHROPIC_API_KEY: optional,
    OPENAI_API_KEY: optional,
    GOOGLE_GENERATIVE_AI_API_KEY: optional,
    OPENROUTER_API_KEY: optional,
    GROQ_API_KEY: optional,
    OLLAMA_BASE_URL: optional,
  })
  .superRefine((e, ctx) => {
    if (!e.LLM_PROVIDER) return;
    if (!e.LLM_MODEL) ctx.addIssue({ code: 'custom', message: 'LLM_MODEL is required when LLM_PROVIDER is set' });
    const keyVar = LLM_CREDENTIAL_ENV[e.LLM_PROVIDER] as keyof typeof e;
    if (e.LLM_PROVIDER !== 'ollama' && !e[keyVar]) {
      ctx.addIssue({ code: 'custom', message: `${keyVar} is required when LLM_PROVIDER=${e.LLM_PROVIDER}` });
    }
  });

type Env = z.infer<typeof schema>;

function llmSettings(e: Env): LlmSettings | null {
  if (!e.LLM_PROVIDER || !e.LLM_MODEL) return null;
  const credentials: Partial<Record<LlmProviderName, LlmCredentials>> = {};
  for (const provider of LLM_PROVIDERS) {
    const value = e[LLM_CREDENTIAL_ENV[provider] as keyof Env] as string | undefined;
    if (provider === 'ollama') {
      if (value || e.LLM_PROVIDER === 'ollama') credentials.ollama = { baseUrl: value ?? DEFAULT_OLLAMA_BASE_URL };
    } else if (value) {
      credentials[provider] = { apiKey: value };
    }
  }
  return { provider: e.LLM_PROVIDER, model: e.LLM_MODEL, credentials };
}

export function parseServerConfig(env: Record<string, string | undefined>): ServerConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  - ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const e = result.data;
  return {
    mongoUrl: e.MONGO_URL,
    mongoDb: e.MONGO_DB,
    core: {
      slackTeamId: e.SLACK_TEAM_ID,
      adminSlackUserIds: e.ADMIN_SLACK_USER_IDS.split(',')
        .map((id) => id.trim())
        .filter(Boolean),
      encryptionKey: e.ENCRYPTION_KEY,
    },
    llm: llmSettings(e),
  };
}
