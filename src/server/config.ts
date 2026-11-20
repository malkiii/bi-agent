import { z } from 'zod';
import type { AppCoreConfig } from '@/core';
import { parseEncryptionKey } from '@/core/secret-box';

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
  /** The shared uploads volume (ADR 0003). */
  uploadsDir: string;
  core: AppCoreConfig;
}

const required = (name: string) => z.string({ error: `${name} is required` }).trim().min(1, `${name} is required`);

const schema = z.object({
  MONGO_URL: required('MONGO_URL'),
  MONGO_DB: z.string().trim().min(1).default('botley'),
  UPLOADS_DIR: z.string().trim().min(1).default('/data/uploads'),
  SLACK_TEAM_ID: required('SLACK_TEAM_ID'),
  ADMIN_SLACK_USER_IDS: z.string().default(''),
  ENCRYPTION_KEY: required('ENCRYPTION_KEY').refine(isEncryptionKey, 'ENCRYPTION_KEY must be 32 bytes, base64- or hex-encoded (openssl rand -base64 32)'),
});

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
    },
  };
}
