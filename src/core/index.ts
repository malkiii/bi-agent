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
import type { Clock, LanguageModelProvider, ResultCombiner, SlackGateway, UploadStorage } from './ports';
import { createUploads, ensureUploadIndexes, type Uploads } from './uploads/uploads';
import { createPreferences, ensurePreferenceIndexes, type Preferences } from './preferences/preferences';
import { createSecretBox } from './secret-box';
import { createUsers, ensureUserIndexes, type Users } from './users/users';
import { createConversations, ensureConversationIndexes, type Conversations } from './conversations/conversations';
import { createSlackBot, ensureSlackBotIndexes, type SlackBot } from './slack/slack-bot';
import { createPinnedQueries, type PinnedQueries } from './pinned-queries/pinned-queries';
import { createLlmSettings, type LlmSettings } from './llm-settings/llm-settings';
import { createSavedQuestions, ensureSavedQuestionIndexes, type SavedQuestions } from './saved-questions/saved-questions';
import { createChannelDefaults, type ChannelDefaults } from './channel-defaults/channel-defaults';
import { createReports, ensureReportIndexes, type Reports } from './reports/reports';
import { createScheduler, ensureJobIndexes, type Scheduler } from './scheduler/scheduler';
import { createKpis, ensureKpiIndexes, type Kpis } from './kpis/kpis';

export * from './errors';
export type * from './ports';
export type { Role, SlackIdentity, User } from './users/users';
export type { ThemePreference } from './preferences/preferences';
export { MAX_MODEL_LENGTH, type LlmSettings, type LlmSettingsView } from './llm-settings/llm-settings';
export { hasExposedDatasets } from './data-sources/data-sources';
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
export type { ChannelDefault, ChannelDefaults } from './channel-defaults/channel-defaults';
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
export { approvableAnswer, reportPath, reportRunPath, REPORT_TITLE_MAX } from './reports/reports';
export type {
  Report,
  ReportDestination,
  ReportDestinationInput,
  ReportFailure,
  ReportOrigin,
  ReportRun,
  ReportRunSummary,
  Reports,
  ReportSettingsInput,
  ReportStatus,
} from './reports/reports';
export { describeSchedule, MONTHLY_MAX_DAY, WEEKDAYS, type ReportSchedule } from './reports/schedule';
export { KPI_NAME_MAX, kpiPath } from './kpis/kpis';
export type { Kpi, KpiAlert, KpiAlertInput, KpiAlertState, KpiAlertStatus, Kpis, KpiStatus, KpiValue } from './kpis/kpis';
export { describeCondition, formatNumber, type KpiAlertCondition } from './kpis/condition';
export type { Scheduler } from './scheduler/scheduler';

export interface AppCoreConfig {
  /** Only this Slack workspace may sign in. */
  slackTeamId: string;
  /** Slack user IDs that become admins on first sign-in. */
  adminSlackUserIds: readonly string[];
  /** 32-byte AES-256-GCM key (base64 or hex) sealing Data Source credentials. */
  encryptionKey: string;
  /** The web app's public URL; Slack Answers ("Open in dashboard") and Report Runs link to it. No link when unset. */
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
  /** Joins results across Data Sources (combineResults); without it the agent can't, and such Pinned Queries fail. */
  combiner?: ResultCombiner;
  /** Called with the underlying error when an Answer fails (model or tool crash), for logging. */
  onAgentError?: (error: unknown) => void;
}

export interface AppCore {
  users: Users;
  preferences: Preferences;
  /** The active LLM provider and model (admin settings). */
  llmSettings: LlmSettings;
  dataSources: DataSources;
  /** The Data Sources the agent prefers per Slack channel (admin settings). */
  channelDefaults: ChannelDefaults;
  conversations: Conversations;
  slackBot: SlackBot;
  pinnedQueries: PinnedQueries;
  savedQuestions: SavedQuestions;
  /** Scheduled Prompts whose runs re-execute Pinned Queries; Report Runs are their frozen pages. */
  reports: Reports;
  /** Named single numbers on Pinned Queries, and the KPI Alerts that watch them. */
  kpis: Kpis;
  /** Runs due scheduled work (Report Runs); the worker calls `runDue()` on a timer. */
  scheduler: Scheduler;
  uploads: Uploads;
}

export function createAppCore(deps: AppCoreDeps): AppCore {
  const users = createUsers(deps);
  const secretBox = createSecretBox(deps.config.encryptionKey);
  const dataSources = createDataSources({ db: deps.db, clock: deps.clock, users, drivers: deps.drivers, secretBox });
  const llmSettings = createLlmSettings({ db: deps.db, clock: deps.clock, users, llm: deps.llm });
  const channelDefaults = createChannelDefaults({ db: deps.db, clock: deps.clock, users, dataSources, slack: deps.slack });
  const conversations = createConversations({
    db: deps.db,
    clock: deps.clock,
    llm: llmSettings.active,
    dataSources,
    onAgentError: deps.onAgentError,
    channelDefault: (channel) => channelDefaults.forChannel(channel),
    combiner: deps.combiner,
  });
  const pinnedQueries = createPinnedQueries({ dataSources, clock: deps.clock, combiner: deps.combiner });
  const savedQuestions = createSavedQuestions({ db: deps.db, clock: deps.clock, users, conversations, pinnedQueries });
  const { scheduler, jobs } = createScheduler({ db: deps.db, clock: deps.clock, onError: deps.onAgentError });
  const reports = createReports({
    db: deps.db,
    clock: deps.clock,
    users,
    slack: deps.slack,
    llm: llmSettings.active,
    conversations,
    savedQuestions,
    pinnedQueries,
    jobs,
    appUrl: deps.config.appUrl,
    onError: deps.onAgentError,
  });
  return {
    users,
    preferences: createPreferences(deps),
    llmSettings: llmSettings.settings,
    dataSources,
    channelDefaults,
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
    savedQuestions,
    reports,
    kpis: createKpis({
      db: deps.db,
      clock: deps.clock,
      users,
      conversations,
      pinnedQueries,
      slack: deps.slack,
      llm: llmSettings.active,
      jobs,
      appUrl: deps.config.appUrl,
      onError: deps.onAgentError,
    }),
    scheduler,
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
  await ensureReportIndexes(db);
  await ensureKpiIndexes(db);
  await ensureJobIndexes(db);
  await ensureUploadIndexes(db);
}
