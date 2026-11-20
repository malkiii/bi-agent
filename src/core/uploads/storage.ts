/**
 * The UploadStorage port: turns uploaded CSV/XLSX files into staged sheets and staged sheets
 * into Dataset files. The production adapter (`src/drivers/uploads/storage.ts`) writes Parquet
 * through DuckDB on the shared uploads volume (ADR 0003). Business rules (size limit, naming,
 * Append column checks, permissions) stay in `core.uploads`.
 */
import type { Column, ColumnType } from '../data-sources/driver';

/** The column types a person can choose for an uploaded column. */
export const UPLOAD_COLUMN_TYPES = ['string', 'integer', 'number', 'boolean', 'date', 'datetime'] as const;
export type UploadColumnType = (typeof UPLOAD_COLUMN_TYPES)[number] & ColumnType;

export interface StagedColumn {
  name: string;
  /** Inferred from every value in the column; `string` when nothing narrower fits. */
  type: UploadColumnType;
}

export interface StagedSheet {
  /** Position in the file (0 for a CSV). */
  index: number;
  /** The XLSX sheet name, or the CSV file name without its extension. */
  name: string;
  columns: StagedColumn[];
  rowCount: number;
  /** The first rows as text (null for empty cells), for the preview. */
  sampleRows: (string | null)[][];
}

export interface WrittenDataset {
  columns: Column[];
  rowCount: number;
}

export interface UploadStorage {
  /** The directory the Uploads Data Source reads (stored in its config). */
  readonly directory: string;
  /**
   * Parses a CSV or XLSX file (first row = header) and keeps every sheet staged under `uploadId`
   * until it is written or discarded. Throws UploadFormatError for unreadable files.
   */
  stage(uploadId: string, file: { name: string; bytes: Uint8Array }): Promise<StagedSheet[]>;
  /**
   * Converts a staged sheet with the given column types and atomically swaps it in as the
   * Dataset's file (creating or replacing it). Throws UploadConversionError when a value does not
   * fit its column type.
   */
  replace(uploadId: string, sheetIndex: number, datasetId: string, types: readonly UploadColumnType[]): Promise<WrittenDataset>;
  /**
   * Appends a staged sheet to an existing Dataset, converting values to the Dataset's column
   * types, by rewriting the file and swapping it in atomically. Columns must already match.
   */
  append(uploadId: string, sheetIndex: number, datasetId: string): Promise<WrittenDataset>;
  /** Deletes a Dataset's file. */
  remove(datasetId: string): Promise<void>;
  /** Deletes everything staged under `uploadId`. */
  discard(uploadId: string): Promise<void>;
}

/** The file could not be read as CSV or XLSX. */
export class UploadFormatError extends Error {}

/** A value does not fit the chosen column type; the message names the column and value. */
export class UploadConversionError extends Error {}
