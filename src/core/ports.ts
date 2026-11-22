/**
 * Ports: everything the App Core needs from the outside world.
 * Production adapters live in `src/adapters`, test doubles in `src/core/testing`.
 */
import type { LanguageModel } from 'ai';
import type { QueryResult } from './data-sources/driver';

export interface Clock {
  now(): Date;
}

/** An LLM provider (e.g. `anthropic`) and one of its model ids. */
export interface LlmChoice {
  provider: string;
  model: string;
}

/** A chat model a provider offers. */
export interface LlmModel {
  id: string;
  /** Display name; the id when the provider gives none. */
  name: string;
}

/**
 * Builds Vercel AI SDK models for the providers whose credentials are configured (in `.env`).
 * Which provider and model are active is an admin setting the App Core keeps.
 */
export interface LanguageModelProvider {
  /** Providers with configured credentials, in display order. */
  configuredProviders(): readonly string[];
  /**
   * The model `provider` answers with until an admin chooses one; null when there is no
   * sensible default (e.g. the provider lists no models). Throws when the provider is not configured.
   */
  defaultModel(provider: string): Promise<string | null>;
  /** The provider's display name, e.g. `OpenAI` or an OpenAI-compatible server's configured name. */
  providerLabel(provider: string): string;
  /** Asks the provider which chat models it offers. Throws when the provider is not configured or the request fails. */
  listModels(provider: string): Promise<LlmModel[]>;
  /** Builds the model. Throws when `choice.provider` is not configured. */
  getModel(choice: LlmChoice): Promise<LanguageModel>;
}

export interface SlackMessageRef {
  channel: string;
  ts: string;
}

export interface SlackMessage {
  channel: string;
  /** Reply in this thread when set. */
  threadTs?: string;
  text: string;
  blocks?: unknown[];
}

export interface SlackFile {
  filename: string;
  title: string;
  content: Uint8Array;
  /** Image description for screen readers. */
  altText?: string;
}

/** Files shared together as one message, e.g. in an Answer's thread. */
export interface SlackFileUpload {
  channel: string;
  threadTs?: string;
  files: SlackFile[];
  /** Text of the message the files are shared with. */
  comment?: string;
}

/** A Slack channel the bot is a member of. */
export interface SlackChannel {
  id: string;
  /** Without the leading #. */
  name: string;
}

/**
 * Outbound Slack operations. Grows as tickets need it;
 * add the method here and to both implementations.
 */
export interface SlackGateway {
  postMessage(message: SlackMessage): Promise<SlackMessageRef>;
  updateMessage(ref: SlackMessageRef, message: Omit<SlackMessage, 'channel' | 'threadTs'>): Promise<void>;
  addReaction(ref: SlackMessageRef, emoji: string): Promise<void>;
  /** Removes the bot's own reaction; no error when it is not there. */
  removeReaction(ref: SlackMessageRef, emoji: string): Promise<void>;
  isBotInChannel(channel: string): Promise<boolean>;
  /** Opens a modal in response to an interaction (`triggerId` expires 3 s after the click). `view` is a Block Kit modal. */
  openModal(triggerId: string, view: unknown): Promise<void>;
  /** Uploads files and shares them in the channel (thread) as one message. Needs the `files:write` scope. */
  uploadFiles(upload: SlackFileUpload): Promise<void>;
  /** Public and private channels the bot is a member of, by name. Needs `channels:read` and `groups:read`. */
  listChannels(): Promise<SlackChannel[]>;
}

/** A column of an uploaded Dataset as stored: engine-independent type plus the store's own type name. */
export interface StoredColumn {
  name: string;
  type: 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'datetime';
  nativeType: string;
}

/** Rows already converted to their column types: text, numbers, booleans, `Date`s (UTC) or null. */
export interface TypedTable {
  columns: readonly Omit<StoredColumn, 'nativeType'>[];
  rows: readonly (readonly (string | number | boolean | Date | null)[])[];
}

/**
 * Where uploaded files and Datasets live (ADR 0003: one Parquet file per Dataset on a shared
 * volume). The Uploads Data Source kind reads the same Datasets.
 */
export interface UploadStorage {
  /** Keeps an uploaded file until it is confirmed; returns its id. Stale staged files are pruned. */
  stage(content: Uint8Array): Promise<string>;
  /** The staged file, or null once it was discarded or pruned. */
  readStaged(stagedId: string): Promise<Uint8Array | null>;
  discardStaged(stagedId: string): Promise<void>;
  /**
   * Stores `table` as the Dataset `datasetId`: `create` only if no such Dataset exists yet (checked
   * atomically, across processes), `replace` swaps its rows, `append` adds to them (same columns
   * expected). Readers see the old or the new data, never a partial file. Returns the stored
   * columns, or null when `create` found the Dataset already there.
   */
  writeDataset(datasetId: string, table: TypedTable, mode: 'create' | 'replace' | 'append'): Promise<StoredColumn[] | null>;
  deleteDataset(datasetId: string): Promise<void>;
}

/**
 * Runs SQL over earlier query results (combineResults): each result becomes a table named by
 * its key in a temporary in-memory database that is thrown away afterwards.
 */
export interface ResultCombiner {
  /** Guidance for the model: which SQL flavour to write. */
  readonly guidance: string;
  /**
   * Runs one read-only SELECT/WITH statement. Throws QueryRejectedError (not read-only),
   * QueryTimeoutError or QueryFailedError (the engine's message, for the model to fix).
   */
  combine(tables: Readonly<Record<string, QueryResult>>, sql: string): Promise<QueryResult>;
}
