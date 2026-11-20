/**
 * App Core: the transport-agnostic application service shared by `web` and `worker`.
 * Construct it with `createAppCore(deps)`; tests construct it via `createTestHarness()`.
 */
import type { Db } from 'mongodb';
import {
  createDataSources,
  createManagedDataSources,
  ensureDataSourceIndexes,
  type DataSources,
} from './data-sources/data-sources';
import type { DriverRegistry } from './data-sources/driver';
import type { Clock, LanguageModelProvider, SlackGateway, UploadStorage } from './ports';
import { createUploads, ensureUploadIndexes, type Uploads } from './uploads/uploads';
import { createPreferences, ensurePreferenceIndexes, type Preferences } from './preferences/preferences';
import { createSecretBox } from './secret-box';
import { createUsers, ensureUserIndexes, type Users } from './users/users';
import { createConversations, ensureConversationIndexes, type Conversations } from './conversations/conversations';
import { createSlackBot, ensureSlackBotIndexes, type SlackBot } from './slack/slack-bot';
import { createPinnedQueries, type PinnedQueries } from './pinned-queries/pinned-queries';
import { createSavedQuestions, ensureSavedQuestionIndexes, type SavedQuestions } from './saved-questions/saved-questions';

export * from './errors';
export type * from './ports';
export type { Role, SlackIdentity, User } from './users/users';
export type { ThemePreference } from './preferences/preferences';
export type {
  CatalogColumn,
  CatalogDataset,
  CatalogDetails,
  ConnectionTestInput,
  DatasetDetailsInput,
  DataSourceInput,
  DataSourceView,
} from './data-sources/data-sources';
export * from './data-sources/driver';
export * from './conversations/answer';
export { CHART_MAX_ROWS, chartViewSpec, DARK_CHART_PALETTE, LIGHT_CHART_PALETTE, type ChartPalette } from './charts/chart';
export { tableFileName, tableToCsv, tableToXlsx, TABLE_FILE_TYPES, type TableFileFormat } from './files/table-files';
export type {
  AskOptions,
  Conversation,
  ConversationMessage,
  ConversationSource,
  ConversationWithMessages,
  HistoryOptions,
  HistoryPage,
} from './conversations/conversations';
export type { SlackBot, SlackPrompt } from './slack/slack-bot';
export { OPEN_IN_DASHBOARD_ACTION_ID, SHOW_QUERY_ACTION_ID } from './slack/render';
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
export {
  MAX_UPLOAD_BYTES,
  UPLOADS_KIND,
  UploadsUnavailableError,
  type ConfirmSheet,
  type ConfirmUploadInput,
  type SheetPreview,
  type UploadColumnPreview,
  type UploadedDataset,
  type UploadFile,
  type UploadMode,
  type UploadPreview,
  type Uploads,
} from './uploads/uploads';
export { UPLOAD_COLUMN_TYPES, type UploadColumnType } from './uploads/column-types';
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
  /** The web app's public URL; Slack Answers link to it ("Open in dashboard"). No link when unset. */
  appUrl?: string;
}

export interface AppCoreDeps {
  db: Db;
  clock: Clock;
  slack: SlackGateway;
  llm: LanguageModelProvider;
  /** The Data Source kinds; production passes `builtInDrivers` from `@/drivers`. */
  drivers: DriverRegistry;
  config: AppCoreConfig;
  /** Where uploaded files and Datasets are stored; uploads are off without it. */
  uploadStorage?: UploadStorage;
  /** Called with the underlying error when an Answer fails (model or tool crash), for logging. */
  onAgentError?: (error: unknown) => void;
}

export interface AppCore {
  users: Users;
  preferences: Preferences;
  dataSources: DataSources;
  conversations: Conversations;
  slackBot: SlackBot;
  pinnedQueries: PinnedQueries;
  savedQuestions: SavedQuestions;
  uploads: Uploads;
}

export function createAppCore(deps: AppCoreDeps): AppCore {
  const users = createUsers(deps);
  const secretBox = createSecretBox(deps.config.encryptionKey);
  const dataSources = createDataSources({ db: deps.db, clock: deps.clock, users, drivers: deps.drivers, secretBox });
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
    conversations,
    slackBot: createSlackBot({
      db: deps.db,
      clock: deps.clock,
      slack: deps.slack,
      conversations,
      appUrl: deps.config.appUrl,
      onError: deps.onAgentError,
    }),
    pinnedQueries,
    savedQuestions: createSavedQuestions({ db: deps.db, clock: deps.clock, users, conversations, pinnedQueries }),
    uploads: createUploads({
      db: deps.db,
      clock: deps.clock,
      users,
      managed: createManagedDataSources({ db: deps.db, clock: deps.clock, secretBox }),
      drivers: deps.drivers,
      storage: deps.uploadStorage,
    }),
  };
}

/** Creates indexes. Idempotent; call once at process start. */
export async function prepareDatabase(db: Db): Promise<void> {
  await ensureUserIndexes(db);
  await ensurePreferenceIndexes(db);
  await ensureDataSourceIndexes(db);
  await ensureConversationIndexes(db);
  await ensureSlackBotIndexes(db);
  await ensureSavedQuestionIndexes(db);
  await ensureUploadIndexes(db);
}
