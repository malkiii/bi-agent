/**
 * App Core: the transport-agnostic application service shared by `web` and `worker`.
 * Construct it with `createAppCore(deps)`; tests construct it via `createTestHarness()`.
 */
import type { Db } from 'mongodb';
import { createDataSources, ensureDataSourceIndexes, type DataSources } from './data-sources/data-sources';
import type { DriverRegistry } from './data-sources/driver';
import type { Clock, LanguageModelProvider, SlackGateway } from './ports';
import { createSecretBox } from './secret-box';
import { createUsers, ensureUserIndexes, type Users } from './users/users';

export * from './errors';
export type * from './ports';
export type { Role, SlackIdentity, User } from './users/users';
export type {
  CatalogDataset,
  ConnectionTestInput,
  DataSourceInput,
  DataSourceView,
} from './data-sources/data-sources';
export * from './data-sources/driver';

export interface AppCoreConfig {
  /** Only this Slack workspace may sign in. */
  slackTeamId: string;
  /** Slack user IDs that become admins on first sign-in. */
  adminSlackUserIds: readonly string[];
  /** 32-byte AES-256-GCM key (base64 or hex) sealing Data Source credentials. */
  encryptionKey: string;
}

export interface AppCoreDeps {
  db: Db;
  clock: Clock;
  slack: SlackGateway;
  llm: LanguageModelProvider;
  /** The Data Source kinds; production passes `builtInDrivers` from `@/drivers`. */
  drivers: DriverRegistry;
  config: AppCoreConfig;
}

export interface AppCore {
  users: Users;
  dataSources: DataSources;
}

export function createAppCore(deps: AppCoreDeps): AppCore {
  const users = createUsers(deps);
  return {
    users,
    dataSources: createDataSources({
      db: deps.db,
      clock: deps.clock,
      users,
      drivers: deps.drivers,
      secretBox: createSecretBox(deps.config.encryptionKey),
    }),
  };
}

/** Creates indexes. Idempotent; call once at process start. */
export async function prepareDatabase(db: Db): Promise<void> {
  await ensureUserIndexes(db);
  await ensureDataSourceIndexes(db);
}
