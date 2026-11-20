/**
 * Uploads: members turn CSV/XLSX files into Datasets of the shared, built-in "Uploads" Data
 * Source (ADR 0003). The flow is preview (parse, stage, infer column types) then confirm (with
 * corrected types; each sheet is created, replaces a Dataset or is appended to one).
 * Files are stored through the UploadStorage port; this module owns the rules.
 */
import { randomUUID } from 'node:crypto';
import { MongoServerError, type Db } from 'mongodb';
import { z } from 'zod';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors';
import type { Clock } from '../ports';
import type { DataSourcesInternal, DataSourceView } from '../data-sources/data-sources';
import type { Column } from '../data-sources/driver';
import type { Users } from '../users/users';
import {
  UPLOAD_COLUMN_TYPES,
  UploadConversionError,
  UploadFormatError,
  type StagedSheet,
  type UploadColumnType,
  type UploadStorage,
} from './storage';

/** The id of the single built-in Uploads Data Source. */
export const UPLOADS_DATA_SOURCE_ID = 'uploads';
export const UPLOADS_DATA_SOURCE_KIND = 'uploads';
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Unconfirmed previews (and their staged files) are discarded after this long. */
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

export interface UploadPreview {
  /** Pass to `confirm`. */
  id: string;
  fileName: string;
  /** Sheets with at least one row (a CSV has one). */
  sheets: StagedSheet[];
}

/** What to do with one previewed sheet. Sheets not listed are not saved. */
export type UploadChoice =
  | {
      sheet: number;
      mode: 'create';
      /** The Dataset name people see; its id (the table name in queries) is derived from it. */
      name: string;
      /** One per column, in order. Default: the inferred types. */
      types?: readonly UploadColumnType[];
    }
  | { sheet: number; mode: 'replace'; datasetId: string; types?: readonly UploadColumnType[] }
  | { sheet: number; mode: 'append'; datasetId: string };

export interface UploadedDataset {
  /** The table name in queries, and the Dataset id in the Uploads Data Source. */
  id: string;
  name: string;
  /** The file and sheet it last came from. */
  fileName: string;
  sheetName: string;
  columns: Column[];
  rowCount: number;
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
}

export interface Uploads {
  /** Creates the built-in Uploads Data Source if needed (and points it at the configured directory). */
  ensureDataSource(): Promise<DataSourceView>;
  /** Any signed-in user: parses and stages a CSV/XLSX file of at most 50 MB. */
  preview(actorSlackUserId: string, file: { name: string; bytes: Uint8Array }): Promise<UploadPreview>;
  /** Saves the chosen sheets of a preview. All choices are checked before anything is written. */
  confirm(actorSlackUserId: string, previewId: string, choices: readonly UploadChoice[]): Promise<UploadedDataset[]>;
  list(): Promise<UploadedDataset[]>;
  /** Admin only: deletes an uploaded Dataset and its file. */
  delete(actorSlackUserId: string, datasetId: string): Promise<void>;
}

const typesSchema = z.array(z.enum(UPLOAD_COLUMN_TYPES)).optional();
const choicesSchema = z.array(
  z.discriminatedUnion('mode', [
    z.object({ sheet: z.number().int(), mode: z.literal('create'), name: z.string(), types: typesSchema }),
    z.object({ sheet: z.number().int(), mode: z.literal('replace'), datasetId: z.string(), types: typesSchema }),
    z.object({ sheet: z.number().int(), mode: z.literal('append'), datasetId: z.string() }),
  ]),
);

interface PreviewDoc {
  _id: string;
  createdBy: string;
  createdAt: Date;
  fileName: string;
  sheets: Pick<StagedSheet, 'index' | 'name' | 'columns'>[];
}

type UploadedDatasetDoc = Omit<UploadedDataset, 'id'> & { _id: string };

interface Deps {
  db: Db;
  clock: Clock;
  users: Users;
  dataSources: DataSourcesInternal;
  storage: UploadStorage;
}

/** `Q1 Sales (EU)` -> `q1_sales_eu`: a plain SQL identifier. */
export function datasetIdFor(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
    .replace(/_+$/, '');
  return /^[0-9]/.test(slug) ? `t_${slug}` : slug;
}

export async function ensureUploadIndexes(db: Db) {
  await db.collection('uploadPreviews').createIndex({ createdAt: 1 });
}

function toDataset({ _id, ...rest }: UploadedDatasetDoc): UploadedDataset {
  return { id: _id, ...rest };
}

export function createUploads({ db, clock, users, dataSources, storage }: Deps): Uploads {
  const previews = db.collection<PreviewDoc>('uploadPreviews');
  const datasets = db.collection<UploadedDatasetDoc>('uploadedDatasets');

  async function requireUser(slackUserId: string) {
    const user = await users.get(slackUserId);
    if (!user) throw new ForbiddenError('Sign in to upload files.');
    return user;
  }

  function ensureDataSource() {
    return dataSources.ensureManaged({
      id: UPLOADS_DATA_SOURCE_ID,
      name: 'Uploads',
      kind: UPLOADS_DATA_SOURCE_KIND,
      config: { directory: storage.directory },
    });
  }

  async function discardExpired() {
    const expired = await previews.find({ createdAt: { $lt: new Date(clock.now().getTime() - PREVIEW_TTL_MS) } }).toArray();
    for (const doc of expired) {
      await storage.discard(doc._id);
      await previews.deleteOne({ _id: doc._id });
    }
  }

  function readable(error: unknown): unknown {
    if (error instanceof UploadFormatError || error instanceof UploadConversionError) {
      return new ValidationError(error.message);
    }
    return error;
  }

  function checkTypes(types: readonly UploadColumnType[] | undefined, sheet: PreviewDoc['sheets'][number]) {
    if (!types) return sheet.columns.map((c) => c.type);
    if (types.length !== sheet.columns.length || types.some((t) => !UPLOAD_COLUMN_TYPES.includes(t))) {
      throw new ValidationError(
        `Choose one of ${UPLOAD_COLUMN_TYPES.join(', ')} for each of the ${sheet.columns.length} columns of "${sheet.name}".`,
      );
    }
    return types;
  }

  function checkSameColumns(existing: UploadedDatasetDoc, sheet: PreviewDoc['sheets'][number]) {
    const have = new Set(existing.columns.map((c) => c.name.toLowerCase()));
    const got = new Set(sheet.columns.map((c) => c.name.toLowerCase()));
    const missing = existing.columns.filter((c) => !got.has(c.name.toLowerCase())).map((c) => c.name);
    const extra = sheet.columns.filter((c) => !have.has(c.name.toLowerCase())).map((c) => c.name);
    if (missing.length > 0 || extra.length > 0) {
      const parts = [missing.length && `missing ${missing.join(', ')}`, extra.length && `unexpected ${extra.join(', ')}`];
      throw new ValidationError(
        `Append needs the same columns as "${existing.name}" (${existing.columns.map((c) => c.name).join(', ')}): ` +
          `${parts.filter(Boolean).join('; ')}. Use Replace to change the columns.`,
      );
    }
  }

  return {
    ensureDataSource,

    async preview(actor, file) {
      await requireUser(actor);
      if (file.bytes.byteLength > MAX_UPLOAD_BYTES) {
        const mb = (file.bytes.byteLength / (1024 * 1024)).toFixed(1);
        throw new ValidationError(`Files can be at most 50 MB; this one is ${mb} MB.`);
      }
      if (!/\.(csv|xlsx)$/i.test(file.name)) {
        throw new ValidationError('Only CSV or XLSX files can be uploaded.');
      }
      await discardExpired();

      const id = randomUUID();
      let sheets: StagedSheet[];
      try {
        sheets = (await storage.stage(id, file)).filter((s) => s.rowCount > 0);
      } catch (error) {
        await storage.discard(id);
        throw readable(error);
      }
      if (sheets.length === 0) {
        await storage.discard(id);
        throw new ValidationError('This file has no rows below its header row.');
      }
      await previews.insertOne({
        _id: id,
        createdBy: actor,
        createdAt: clock.now(),
        fileName: file.name,
        sheets: sheets.map(({ index, name, columns }) => ({ index, name, columns })),
      });
      return { id, fileName: file.name, sheets };
    },

    async confirm(actor, previewId, choices) {
      await requireUser(actor);
      const preview = await previews.findOne({ _id: previewId });
      if (!preview || preview.createdBy !== actor) throw new NotFoundError('That upload has expired. Upload the file again.');
      const parsed = choicesSchema.safeParse(choices);
      if (!parsed.success) throw new ValidationError('Some upload choices are malformed.');
      choices = parsed.data;
      if (choices.length === 0) throw new ValidationError('Choose at least one sheet to save.');

      // Check every choice before writing anything.
      const ids = new Set<string>();
      const plans = [];
      for (const choice of choices) {
        const sheet = preview.sheets.find((s) => s.index === choice.sheet);
        if (!sheet) throw new ValidationError(`The file has no sheet ${choice.sheet}.`);
        if (choice.mode === 'create') {
          const name = choice.name.trim();
          const id = datasetIdFor(name);
          if (!id) throw new ValidationError('Give the Dataset a name with letters or digits.', { name: 'Required' });
          if (ids.has(id) || (await datasets.countDocuments({ _id: id })) > 0) {
            throw new ValidationError(`A Dataset named "${id}" already exists. Choose Replace or Append to update it.`, {
              name: 'Already in use',
            });
          }
          ids.add(id);
          plans.push({ choice, sheet, id, name, types: checkTypes(choice.types, sheet), existing: null });
        } else {
          const existing = await datasets.findOne({ _id: choice.datasetId });
          if (!existing) throw new NotFoundError(`There is no uploaded Dataset "${choice.datasetId}".`);
          if (ids.has(existing._id)) throw new ValidationError(`"${existing._id}" is chosen twice.`);
          ids.add(existing._id);
          if (choice.mode === 'append') checkSameColumns(existing, sheet);
          const types = choice.mode === 'replace' ? checkTypes(choice.types, sheet) : [];
          plans.push({ choice, sheet, id: existing._id, name: existing.name, types, existing });
        }
      }

      await ensureDataSource();
      const saved: UploadedDataset[] = [];
      const created: string[] = [];
      for (const { choice, sheet, id, name, types, existing } of plans) {
        const now = clock.now();
        if (!existing) {
          try {
            // Reserve the id first so two people cannot create the same Dataset at once.
            await datasets.insertOne({
              _id: id,
              name,
              fileName: preview.fileName,
              sheetName: sheet.name,
              columns: [],
              rowCount: 0,
              createdBy: actor,
              createdAt: now,
              updatedBy: actor,
              updatedAt: now,
            });
          } catch (error) {
            if (error instanceof MongoServerError && error.code === 11000) {
              throw new ValidationError(`A Dataset named "${id}" already exists. Choose Replace or Append to update it.`);
            }
            throw error;
          }
        }
        let written;
        try {
          written =
            choice.mode === 'append'
              ? await storage.append(previewId, sheet.index, id)
              : await storage.replace(previewId, sheet.index, id, types);
        } catch (error) {
          if (!existing) await datasets.deleteOne({ _id: id });
          throw readable(error);
        }
        const doc = await datasets.findOneAndUpdate(
          { _id: id },
          {
            $set: {
              fileName: preview.fileName,
              sheetName: sheet.name,
              columns: written.columns,
              rowCount: written.rowCount,
              updatedBy: actor,
              updatedAt: now,
            },
          },
          { returnDocument: 'after' },
        );
        saved.push(toDataset(doc!));
        if (!existing) created.push(id);
      }

      await previews.deleteOne({ _id: previewId });
      await storage.discard(previewId);
      await dataSources.syncSchema(UPLOADS_DATA_SOURCE_ID, actor, created);
      return saved;
    },

    async list() {
      const docs = await datasets.find({ rowCount: { $gt: 0 } }).sort({ _id: 1 }).toArray();
      return docs.map(toDataset);
    },

    async delete(actor, datasetId) {
      await users.requireAdmin(actor);
      const { deletedCount } = await datasets.deleteOne({ _id: datasetId });
      if (deletedCount === 0) throw new NotFoundError(`There is no uploaded Dataset "${datasetId}".`);
      await storage.remove(datasetId);
      await ensureDataSource();
      await dataSources.syncSchema(UPLOADS_DATA_SOURCE_ID, actor, []);
    },
  };
}
