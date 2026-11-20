/**
 * Ports: everything the App Core needs from the outside world.
 * Production adapters live in `src/adapters`, test doubles in `src/core/testing`.
 */
import type { LanguageModel } from 'ai';

export interface Clock {
  now(): Date;
}

/** Resolves the active Vercel AI SDK model (provider + model come from settings). */
export interface LanguageModelProvider {
  getModel(): Promise<LanguageModel>;
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

/**
 * Outbound Slack operations. Grows as tickets need it;
 * add the method here and to both implementations.
 */
export interface SlackGateway {
  postMessage(message: SlackMessage): Promise<SlackMessageRef>;
  updateMessage(ref: SlackMessageRef, message: Omit<SlackMessage, 'channel' | 'threadTs'>): Promise<void>;
  addReaction(ref: SlackMessageRef, emoji: string): Promise<void>;
  isBotInChannel(channel: string): Promise<boolean>;
  /** Opens a modal in response to an interaction (`triggerId` expires 3 s after the click). `view` is a Block Kit modal. */
  openModal(triggerId: string, view: unknown): Promise<void>;
  /** Uploads files and shares them in the channel (thread) as one message. Needs the `files:write` scope. */
  uploadFiles(upload: SlackFileUpload): Promise<void>;
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
