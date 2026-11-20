/**
 * Uploads (ADR 0003): members upload CSV/XLSX files; each sheet becomes a Dataset of the shared
 * "Uploads" Data Source, stored as one Parquet file through the UploadStorage port.
 *
 * Two steps: `preview` reads the file and infers column types; `confirm` applies the member's
 * corrections and stores each chosen sheet as a new Dataset, or replaces or appends to an
 * existing one. Uploaded Datasets are exposed to the agent straight away.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { AppError, NotFoundError, ValidationError } from '../errors';
import type { Clock, StoredColumn, UploadStorage } from '../ports';
import {
  mergeCatalogDataset,
  type CatalogDataset,
  type DataSourceView,
  type ManagedDataSources,
} from '../data-sources/data-sources';
import type { DriverRegistry } from '../data-sources/driver';
import type { Users } from '../users/users';
import { baseName, cellText, readUploadFile, type RawSheet } from './read-file';
import {
  columnNames,
  convertCell,
  inferColumnType,
  toIdentifier,
  UPLOAD_COLUMN_TYPES,
  type StoredValue,
  type UploadColumnType,
} from './column-types';

export const UPLOADS_KIND = 'uploads';
export const UPLOADS_DATA_SOURCE_NAME = 'Uploads';
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Rows of each sheet shown in the preview. */
export const PREVIEW_ROWS = 10;
/** How long a previewed upload waits for confirmation. */
const PENDING_TTL_MS = 60 * 60_000;

export interface UploadFile {
  filename: string;
  content: Uint8Array;
}

export interface UploadColumnPreview {
  /** The column name in the Dataset (an identifier made from the header). */
  name: string;
  /** The header cell as written in the file. */
  header: string;
  /** The inferred type; the member may correct it on confirm. */
  type: UploadColumnType;
}

export interface SheetPreview {
  sheet: string;
  /** Suggested Dataset name (id): the file name, plus the sheet name for workbooks with several sheets. */
  datasetName: string;
  rowCount: number;
  columns: UploadColumnPreview[];
  /** The first rows as text, in column order. */
  sampleRows: string[][];
}

export interface UploadPreview {
  uploadId: string;
  filename: string;
  sheets: SheetPreview[];
}

/** `new` creates a Dataset; `replace` swaps an existing one's rows; `append` adds rows (same columns). */
export type UploadMode = 'new' | 'replace' | 'append';

export interface ConfirmSheet {
  sheet: string;
  datasetName: string;
  mode: UploadMode;
  /** Corrected types by column name; columns left out keep the inferred type. */
  columnTypes?: Readonly<Record<string, UploadColumnType>>;
}

export interface ConfirmUploadInput {
  uploadId: string;
  /** The sheets to store; sheets left out are skipped. */
  sheets: readonly ConfirmSheet[];
}

/** An uploaded Dataset with who uploaded it, as listed on the Uploads page. */
export interface UploadedDataset {
  dataSourceId: string;
  datasetId: string;
  columns: StoredColumn[];
  rowCount: number;
  /** The file (and sheet) the latest rows came from. */
  filename: string;
  sheet: string;
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
}

export interface Uploads {
  /** Reads the file and stages it for `confirm`. Refuses files over 50 MB and formats other than CSV/XLSX. */
  preview(actorSlackUserId: string, file: UploadFile): Promise<UploadPreview>;
  /** Stores the chosen sheets. Validates every sheet before writing any. */
  confirm(actorSlackUserId: string, input: ConfirmUploadInput): Promise<UploadedDataset[]>;
  /** Every uploaded Dataset, by id. */
  list(): Promise<UploadedDataset[]>;
  /** Admin only: removes the Dataset and its file. */
  delete(actorSlackUserId: string, datasetId: string): Promise<void>;
}

/** Uploads are switched off: no storage configured, or no Uploads driver kind registered. */
export class UploadsUnavailableError extends AppError {
  constructor() {
    super('uploads_unavailable', 'Uploads are not set up on this server. Ask an admin to configure UPLOADS_DIR.');
  }
}

interface PendingUploadDoc {
  _id: string;
  stagedId: string;
  filename: string;
  actor: string;
  expiresAt: Date;
}

interface UploadedDatasetDoc {
  _id: string;
  rowCount: number;
  filename: string;
  sheet: string;
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
}

interface Deps {
  db: Db;
  clock: Clock;
  users: Users;
  managed: ManagedDataSources;
  drivers: DriverRegistry;
  storage?: UploadStorage;
}

/** One sheet ready to write: validated name, mode and converted rows. */
interface PlannedSheet {
  datasetId: string;
  sheet: string;
  mode: UploadMode;
  columns: { name: string; type: UploadColumnType }[];
  rows: StoredValue[][];
  existing?: CatalogDataset;
}

export function createUploads({ db, clock, users, managed, drivers, storage }: Deps): Uploads {
  const pending = db.collection<PendingUploadDoc>('pendingUploads');
  const uploaded = db.collection<UploadedDatasetDoc>('uploadedDatasets');

  function requireStorage(): UploadStorage {
    if (!storage || !drivers[UPLOADS_KIND]) throw new UploadsUnavailableError();
    return storage;
  }

  function previewSheet(raw: RawSheet, filename: string, sheetCount: number): SheetPreview {
    const names = columnNames(raw.header);
    const width = names.length;
    return {
      sheet: raw.name,
      datasetName: suggestedName(filename, raw.name, sheetCount),
      rowCount: raw.rows.length,
      columns: names.map((name, i) => ({
        name,
        header: raw.header[i] ?? '',
        type: inferColumnType(raw.rows.map((r) => r[i] ?? null)),
      })),
      sampleRows: raw.rows.slice(0, PREVIEW_ROWS).map((r) => Array.from({ length: width }, (_, i) => cellText(r[i] ?? null))),
    };
  }

  async function loadPending(actor: string, uploadId: string): Promise<PendingUploadDoc> {
    const doc = await pending.findOne({ _id: uploadId });
    if (!doc || doc.actor !== actor || doc.expiresAt <= clock.now()) {
      throw new NotFoundError('This upload has expired. Upload the file again.');
    }
    return doc;
  }

  function plan(raw: RawSheet, choice: ConfirmSheet, uploadsSource: DataSourceView | null): PlannedSheet {
    const label = `Sheet "${raw.name}"`;
    const datasetId = toIdentifier(choice.datasetName ?? '');
    if (!datasetId) throw new ValidationError(`${label}: enter a Dataset name.`, { datasetName: 'Required' });
    if (!['new', 'replace', 'append'].includes(choice.mode)) {
      throw new ValidationError(`${label}: choose New, Replace or Append.`);
    }
    const existing = uploadsSource?.datasets.find((d) => d.id === datasetId);
    if (choice.mode === 'new' && existing) throw datasetExists(datasetId);
    if (choice.mode !== 'new' && !existing) {
      throw new ValidationError(`There is no uploaded Dataset named ${datasetId} to ${choice.mode}.`, {
        datasetName: 'Not found',
      });
    }

    const names = columnNames(raw.header);
    const corrections = choice.columnTypes ?? {};
    const unknown = Object.keys(corrections).filter((name) => !names.includes(name));
    if (unknown.length > 0) throw new ValidationError(`${label} has no columns named ${unknown.join(', ')}.`);
    const columns = names.map((name, i) => {
      const type = corrections[name] ?? inferColumnType(raw.rows.map((r) => r[i] ?? null));
      if (!UPLOAD_COLUMN_TYPES.includes(type)) throw new ValidationError(`${label}: unknown type "${type}" for ${name}.`);
      return { name, type };
    });

    if (choice.mode === 'append') {
      const expected = existing!.columns.map((c) => `${c.name} (${c.type})`);
      const got = columns.map((c) => `${c.name} (${c.type})`);
      if (expected.join(',') !== got.join(',')) {
        throw new ValidationError(
          `Append needs the same columns as ${datasetId}. Expected ${expected.join(', ')}; this sheet has ${got.join(', ')}.`,
        );
      }
    }

    const problems: string[] = [];
    const rows = raw.rows.map((cells, r) =>
      columns.map((column, i) => {
        const value = convertCell(cells[i] ?? null, column.type);
        if (value !== undefined) return value;
        if (!problems.some((p) => p.startsWith(`${column.name} `))) {
          // Row numbers as in a spreadsheet: the header is row 1.
          problems.push(`${column.name} (${column.type}): row ${r + 2} has "${cellText(cells[i] ?? null)}"`);
        }
        return null;
      }),
    );
    if (problems.length > 0) {
      throw new ValidationError(
        `${label}: some values don't match their column type. Correct the type or the file. ${problems.slice(0, 5).join('; ')}.`,
      );
    }
    return { datasetId, sheet: raw.name, mode: choice.mode, columns, rows, ...(existing && { existing }) };
  }

  function toUploaded(dataSourceId: string, dataset: CatalogDataset | undefined, doc: UploadedDatasetDoc): UploadedDataset {
    return {
      dataSourceId,
      datasetId: doc._id,
      columns: (dataset?.columns ?? []).map(({ name, type, nativeType }) => ({ name, type, nativeType }) as StoredColumn),
      rowCount: doc.rowCount,
      filename: doc.filename,
      sheet: doc.sheet,
      createdBy: doc.createdBy,
      createdAt: doc.createdAt,
      updatedBy: doc.updatedBy,
      updatedAt: doc.updatedAt,
    };
  }

  return {
    async preview(actor, file) {
      const store = requireStorage();
      if (file.content.byteLength > MAX_UPLOAD_BYTES) {
        // Rounded up, so a file just over the limit never reads as "50.0 MB".
        const mb = (Math.ceil((file.content.byteLength / 1024 / 1024) * 10) / 10).toFixed(1);
        throw new ValidationError(`This file is ${mb} MB; uploads can be at most 50 MB.`, { file: 'Larger than 50 MB' });
      }
      const sheets = await readUploadFile(file.filename, file.content);
      const stagedId = await store.stage(file.content);
      const uploadId = randomUUID();
      await pending.insertOne({
        _id: uploadId,
        stagedId,
        filename: file.filename,
        actor,
        expiresAt: new Date(clock.now().getTime() + PENDING_TTL_MS),
      });
      return {
        uploadId,
        filename: file.filename,
        sheets: sheets.map((s) => previewSheet(s, file.filename, sheets.length)),
      };
    },

    async confirm(actor, input) {
      const store = requireStorage();
      const upload = await loadPending(actor, input.uploadId);
      if (!input.sheets?.length) throw new ValidationError('Choose at least one sheet to upload.');
      const content = await store.readStaged(upload.stagedId);
      if (!content) throw new NotFoundError('This upload has expired. Upload the file again.');
      const raws = await readUploadFile(upload.filename, content);

      const source = await managed.find(UPLOADS_KIND);
      const plans = input.sheets.map((choice) => {
        const raw = raws.find((s) => s.name === choice.sheet);
        if (!raw) throw new ValidationError(`The file has no sheet named "${choice.sheet}".`);
        return plan(raw, choice, source);
      });
      const duplicate = plans.find((p, i) => plans.findIndex((q) => q.datasetId === p.datasetId) !== i);
      if (duplicate) throw new ValidationError(`Two sheets would both be stored as ${duplicate.datasetId}; rename one.`);

      const uploadsSource = source ?? (await managed.ensure(UPLOADS_KIND, UPLOADS_DATA_SOURCE_NAME));
      const results: UploadedDataset[] = [];
      for (const p of plans) {
        const stored = await store.writeDataset(
          p.datasetId,
          { columns: p.columns, rows: p.rows },
          p.mode === 'new' ? 'create' : p.mode,
        );
        // Someone else created it since the check above.
        if (!stored) throw datasetExists(p.datasetId);
        const dataset = mergeCatalogDataset(
          p.existing,
          {
            id: p.datasetId,
            name: p.datasetId,
            schema: null,
            kind: 'sheet',
            columns: stored.map((c) => ({ name: c.name, type: c.type, nativeType: c.nativeType, nullable: true })),
          },
          { exposedByDefault: true },
        );
        await managed.putDataset(uploadsSource.id, dataset);
        const now = clock.now();
        const append = p.mode === 'append';
        const doc = await uploaded.findOneAndUpdate(
          { _id: p.datasetId },
          {
            $set: {
              filename: upload.filename,
              sheet: p.sheet,
              updatedBy: actor,
              updatedAt: now,
              ...(!append && { rowCount: p.rows.length }),
            },
            ...(append && { $inc: { rowCount: p.rows.length } }),
            $setOnInsert: { createdBy: actor, createdAt: now },
          },
          { upsert: true, returnDocument: 'after' },
        );
        results.push(toUploaded(uploadsSource.id, dataset, doc!));
      }

      await pending.deleteOne({ _id: upload._id });
      await store.discardStaged(upload.stagedId);
      return results;
    },

    async list() {
      const source = await managed.find(UPLOADS_KIND);
      if (!source) return [];
      const docs = await uploaded.find().sort({ _id: 1 }).toArray();
      return docs.flatMap((doc) => {
        const dataset = source.datasets.find((d) => d.id === doc._id);
        return dataset ? [toUploaded(source.id, dataset, doc)] : [];
      });
    },

    async delete(actor, datasetId) {
      await users.requireAdmin(actor);
      const store = requireStorage();
      const source = await managed.find(UPLOADS_KIND);
      if (!source?.datasets.some((d) => d.id === datasetId)) throw new NotFoundError('Uploaded Dataset not found.');
      await managed.removeDataset(source.id, datasetId);
      await uploaded.deleteOne({ _id: datasetId });
      await store.deleteDataset(datasetId);
    },
  };
}

function datasetExists(datasetId: string) {
  return new ValidationError(
    `A Dataset named ${datasetId} already exists. Choose another name, or Replace or Append to it.`,
    { datasetName: 'Already exists' },
  );
}

function suggestedName(filename: string, sheet: string, sheetCount: number): string {
  const file = toIdentifier(baseName(filename)) || 'upload';
  if (sheetCount === 1) return file;
  return toIdentifier(`${file}_${sheet}`) || file;
}

export async function ensureUploadIndexes(db: Db) {
  await db.collection('pendingUploads').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}
