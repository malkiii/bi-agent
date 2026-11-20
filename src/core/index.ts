/**
 * App Core: the transport-agnostic application service shared by `web` and `worker`.
 * Construct it with `createAppCore(deps)`; tests construct it via `createTestHarness()`.
 */
import type { Db } from 'mongodb';
import type { Clock, LanguageModelProvider, SlackGateway } from './ports';
import { createUsers, ensureUserIndexes, type Users } from './users/users';

export * from './errors';
export type * from './ports';
export type { Role, SlackIdentity, User } from './users/users';

export interface AppCoreConfig {
  /** Only this Slack workspace may sign in. */
  slackTeamId: string;
  /** Slack user IDs that become admins on first sign-in. */
  adminSlackUserIds: readonly string[];
}

export interface AppCoreDeps {
  db: Db;
  clock: Clock;
  slack: SlackGateway;
  llm: LanguageModelProvider;
  config: AppCoreConfig;
}

export interface AppCore {
  users: Users;
}

export function createAppCore(deps: AppCoreDeps): AppCore {
  return {
    users: createUsers(deps),
  };
}

/** Creates indexes. Idempotent; call once at process start. */
export async function prepareDatabase(db: Db): Promise<void> {
  await ensureUserIndexes(db);
}
