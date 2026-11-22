import { z } from 'zod';
import type { AppCoreConfig } from '@/core';
import { parseEncryptionKey } from '@/core/secret-box';
import { LLM_CREDENTIAL_ENV, LLM_PROVIDERS, type LlmCredentials, type LlmConfig, type LlmProviderName } from '@/adapters/llm-settings';

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
  /** Shared volume for uploaded Datasets (ADR 0003); `web` and `worker` must see the same directory. */
  uploadsDir: string;
  core: AppCoreConfig;
  /** LLM credentials, one entry per key (or server URL) in the environment; null when there are none (Answers then fail). */
  llm: LlmConfig | null;
  /** Slack bot (worker Socket Mode, outbound messages); absent when SLACK_BOT_TOKEN is unset. */
  slack?: SlackSettings;
}

export interface SlackSettings {
  /** Bot token (`xoxb-…`) for the Web API. */
  botToken: string;
  /** App-level token (`xapp-…`, `connections:write`) for Socket Mode; only the worker needs it. */
  appToken?: string;
}

const required = (name: string) => z.string({ error: `${name} is required` }).trim().min(1, `${name} is required`);
const optional = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || undefined);

const schema = z
  .object({
    MONGO_URL: required('MONGO_URL'),
    MONGO_DB: z.string().trim().min(1).default('bibot'),
    UPLOADS_DIR: z.string().trim().min(1).default('data/uploads'),
    SLACK_TEAM_ID: required('SLACK_TEAM_ID'),
    ADMIN_SLACK_USER_IDS: z.string().default(''),
    ENCRYPTION_KEY: required('ENCRYPTION_KEY').refine(isEncryptionKey, 'ENCRYPTION_KEY must be 32 bytes, base64- or hex-encoded (openssl rand -base64 32)'),
    ANTHROPIC_API_KEY: optional,
    OPENAI_API_KEY: optional,
    GOOGLE_GENERATIVE_AI_API_KEY: optional,
    OPENROUTER_API_KEY: optional,
    GROQ_API_KEY: optional,
    OLLAMA_BASE_URL: optional,
    OPENAI_COMPATIBLE_BASE_URL: optional.refine(
      (v) => !v || isHttpUrl(v),
      'OPENAI_COMPATIBLE_BASE_URL must be an http(s) URL, e.g. http://localhost:8000/v1',
    ),
    OPENAI_COMPATIBLE_API_KEY: optional,
    OPENAI_COMPATIBLE_NAME: optional,
    SLACK_BOT_TOKEN: optional.refine((v) => !v || v.startsWith('xoxb-'), 'SLACK_BOT_TOKEN must be a bot token (xoxb-…)'),
    SLACK_APP_TOKEN: optional.refine((v) => !v || v.startsWith('xapp-'), 'SLACK_APP_TOKEN must be an app-level token (xapp-…)'),
    APP_URL: optional.refine((v) => !v || isHttpUrl(v), 'APP_URL must be an http(s) URL, e.g. https://bibot.example.com'),
    AUTH_URL: optional,
  })
  .superRefine((e, ctx) => {
    if (e.OPENAI_COMPATIBLE_API_KEY && !e.OPENAI_COMPATIBLE_BASE_URL) {
      ctx.addIssue({ code: 'custom', message: 'OPENAI_COMPATIBLE_BASE_URL is required when OPENAI_COMPATIBLE_API_KEY is set' });
    }
  });

type Env = z.infer<typeof schema>;

function llmConfig(e: Env): LlmConfig | null {
  const credentials: Partial<Record<LlmProviderName, LlmCredentials>> = {};
  for (const provider of LLM_PROVIDERS) {
    const value = e[LLM_CREDENTIAL_ENV[provider] as keyof Env] as string | undefined;
    if (provider === 'ollama') {
      if (value) credentials.ollama = { baseUrl: value };
    } else if (provider === 'openai-compatible') {
      if (value) {
        credentials[provider] = { baseUrl: value, ...(e.OPENAI_COMPATIBLE_API_KEY && { apiKey: e.OPENAI_COMPATIBLE_API_KEY }) };
      }
    } else if (value) {
      credentials[provider] = { apiKey: value };
    }
  }
  if (Object.keys(credentials).length === 0) return null;
  return {
    credentials,
    ...(e.OPENAI_COMPATIBLE_NAME && { labels: { 'openai-compatible': e.OPENAI_COMPATIBLE_NAME } }),
  };
}

function isHttpUrl(text: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(text).protocol);
  } catch {
    return false;
  }
}

/** Where people open the web app: APP_URL, else Auth.js's AUTH_URL (when it is a valid URL). */
function appUrl(e: Env): { appUrl?: string } {
  const url = e.APP_URL ?? (e.AUTH_URL && isHttpUrl(e.AUTH_URL) ? e.AUTH_URL : undefined);
  return url ? { appUrl: url.replace(/\/+$/, '') } : {};
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
    uploadsDir: e.UPLOADS_DIR,
    core: {
      slackTeamId: e.SLACK_TEAM_ID,
      adminSlackUserIds: e.ADMIN_SLACK_USER_IDS.split(',')
        .map((id) => id.trim())
        .filter(Boolean),
      encryptionKey: e.ENCRYPTION_KEY,
      ...appUrl(e),
    },
    llm: llmConfig(e),
    ...(e.SLACK_BOT_TOKEN && { slack: { botToken: e.SLACK_BOT_TOKEN, ...(e.SLACK_APP_TOKEN && { appToken: e.SLACK_APP_TOKEN }) } }),
  };
}
