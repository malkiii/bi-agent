/**
 * App Core: the transport-agnostic application service shared by `web` and `worker`.
 * Construct it with `createAppCore(deps)`; tests construct it via `createTestHarness()`.
 */
import type { Db } from 'mongodb';
import { createDataSources, ensureDataSourceIndexes, type DataSources } from './data-sources/data-sources';
import type { DriverRegistry } from './data-sources/driver';
import type { Clock, LanguageModelProvider, SlackGateway } from './ports';
import { createPreferences, ensurePreferenceIndexes, type Preferences } from './preferences/preferences';
import { createSecretBox } from './secret-box';
import { createUsers, ensureUserIndexes, type Users } from './users/users';
import type { UploadStorage } from './uploads/storage';
import { createUploads, ensureUploadIndexes, type Uploads } from './uploads/uploads';
import { createConversations, ensureConversationIndexes, type Conversations } from './conversations/conversations';
import { createPinnedQueries, type PinnedQueries } from './pinned-queries/pinned-queries';
import { createSavedQuestions, ensureSavedQuestionIndexes, type SavedQuestions } from './saved-questions/saved-questions';

export * from './errors';
export type * from './ports';
export type { Role, SlackIdentity, User } from './users/users';
export type { ThemePreference } from './preferences/preferences';
export type {
  CatalogDataset,
  ConnectionTestInput,
  DataSourceInput,
  DataSourceView,
} from './data-sources/data-sources';
export * from './data-sources/driver';
export {
  MAX_UPLOAD_BYTES,
  UPLOADS_DATA_SOURCE_ID,
  type UploadChoice,
  type UploadedDataset,
  type UploadPreview,
} from './uploads/uploads';
export {
  UPLOAD_COLUMN_TYPES,
  UploadConversionError,
  UploadFormatError,
  type StagedColumn,
  type StagedSheet,
  type UploadColumnType,
  type UploadStorage,
  type WrittenDataset,
} from './uploads/storage';
export * from './conversations/answer';
export type {
  AskOptions,
  Conversation,
  ConversationMessage,
  ConversationSource,
  ConversationWithMessages,
} from './conversations/conversations';
export type { AgentToolContext, AgentToolkit, AgentToolkitFactory } from './agent/tools';
export { pinAnswer, PinnedBlockError } from './pinned-queries/pinned-queries';
export type {
  PinnedAnswer,
  PinnedBlock,
  PinnedQueries,
  PinnedQuery,
  PinnedRun,
  PinnedRunBlock,
} from './pinned-queries/pinned-queries';
export type {
  SaveQuestionInput,
  SavedQuestion,
  SavedQuestions,
  SavedQuestionVisibility,
} from './saved-questions/saved-questions';

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
  /** Where uploaded Datasets are stored; production passes `createUploadStorage` from `@/drivers/uploads/storage`. */
  uploads: UploadStorage;
  config: AppCoreConfig;
  /** Called with the underlying error when an Answer fails (model or tool crash), for logging. */
  onAgentError?: (error: unknown) => void;
}

export interface AppCore {
  users: Users;
  preferences: Preferences;
  dataSources: DataSources;
  uploads: Uploads;
  conversations: Conversations;
  pinnedQueries: PinnedQueries;
  savedQuestions: SavedQuestions;
}

export function createAppCore(deps: AppCoreDeps): AppCore {
  const users = createUsers(deps);
  const dataSources = createDataSources({
    db: deps.db,
    clock: deps.clock,
    users,
    drivers: deps.drivers,
    secretBox: createSecretBox(deps.config.encryptionKey),
  });
  const conversations = createConversations({
    db: deps.db,
    clock: deps.clock,
    llm: deps.llm,
    dataSources,
    onAgentError: deps.onAgentError,
  });
  const pinnedQueries = createPinnedQueries({ dataSources, clock: deps.clock });
  return {
    users,
    preferences: createPreferences(deps),
    dataSources,
    uploads: createUploads({ db: deps.db, clock: deps.clock, users, dataSources, storage: deps.uploads }),
    conversations,
    pinnedQueries,
    savedQuestions: createSavedQuestions({ db: deps.db, clock: deps.clock, users, conversations, pinnedQueries }),
  };
}

/** Creates indexes. Idempotent; call once at process start. */
export async function prepareDatabase(db: Db): Promise<void> {
  await ensureUserIndexes(db);
  await ensurePreferenceIndexes(db);
  await ensureDataSourceIndexes(db);
  await ensureUploadIndexes(db);
  await ensureConversationIndexes(db);
  await ensureSavedQuestionIndexes(db);
}
