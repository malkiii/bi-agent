/**
 * MongoDB driver. A query is one structured request (see `parseMongoQuery`):
 *
 *   { find: '<collection>', filter?, projection?, sort?, skip?, limit? }
 *   { aggregate: '<collection>', pipeline: [ ...stages ] }
 *
 * Read-only enforcement: only those two shapes are accepted (no other command or option),
 * and `$out`, `$merge`, `$function`, `$where`, `$accumulator` and change streams are refused
 * wherever they appear (nested pipelines, `$facet`, `$expr`, projections...). `maxTimeMS`
 * cancels slow queries on the server; only maxRows + 1 documents are fetched.
 *
 * Results are flattened to columns and rows (see `flattenDocument`), and introspection
 * applies the same rule to a `$sample` of each collection.
 */
import { BSON, MongoClient, MongoServerError, type Document } from 'mongodb';
import { z } from 'zod';
import {
  DEFAULT_QUERY_LIMITS,
  QueryFailedError,
  QueryRejectedError,
  QueryTimeoutError,
  type Column,
  type ColumnType,
  type DataSourceDriver,
  type Dialect,
  type DriverKind,
  type DriverQuery,
  type IntrospectedDataset,
  type ResultColumn,
} from '@/core/data-sources/driver';

export interface MongoConnection {
  /** A `mongodb://` or `mongodb+srv://` connection string. */
  uri: string;
  database: string;
}

export interface MongoDriverOptions {
  /** How long to wait for a reachable server before failing (default 10 s). */
  serverSelectionTimeoutMs?: number;
  /** Documents sampled per collection by `introspect()` (default 100). */
  sampleSize?: number;
}

export const MONGO_DIALECT: Dialect = {
  language: 'mongo',
  flavour: 'mongodb',
  guidance:
    'MongoDB. Write one JSON object: either {"find": "<collection>", "filter": {...}, "projection": {...}, ' +
    '"sort": {...}, "skip": 0, "limit": 100} (all but "find" optional) or {"aggregate": "<collection>", ' +
    '"pipeline": [ ...stages ]}. $out, $merge, $function, $where and $accumulator are refused. Write typed ' +
    'values as Extended JSON, e.g. {"$date": "2026-01-01T00:00:00Z"}, {"$oid": "..."}. The result is a table: ' +
    'each document is a row, fields of nested subdocuments become dotted columns (address.city), arrays stay ' +
    'JSON values and missing fields are null. Use $project/$group to name the output columns.',
};

/** Refused anywhere in a query: they write, or run server-side JavaScript, or never finish. */
const FORBIDDEN_OPERATORS = new Set([
  '$out',
  '$merge',
  '$function',
  '$where',
  '$accumulator',
  '$changeStream',
  '$changeStreamSplitLargeEvent',
]);

export type MongoQuery =
  | {
      kind: 'find';
      collection: string;
      filter: Document;
      projection?: Document;
      sort?: Document;
      skip?: number;
      limit?: number;
    }
  | { kind: 'aggregate'; collection: string; pipeline: Document[] };

const FIND_KEYS = new Set(['find', 'filter', 'projection', 'sort', 'skip', 'limit']);
const AGGREGATE_KEYS = new Set(['aggregate', 'pipeline']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertNoForbiddenOperators(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoForbiddenOperators);
  } else if (isPlainObject(value)) {
    for (const [key, inner] of Object.entries(value)) {
      if (FORBIDDEN_OPERATORS.has(key)) {
        throw new QueryRejectedError(`${key} is not allowed: BIBot only runs read-only find and aggregate queries.`);
      }
      assertNoForbiddenOperators(inner);
    }
  }
}

function collectionName(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('$') || value.includes('\0')) {
    throw new QueryRejectedError(`"${key}" must be the name of a collection.`);
  }
  return value;
}

function optionalObject(query: Record<string, unknown>, key: string): Document | undefined {
  const value = query[key];
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw new QueryRejectedError(`"${key}" must be an object.`);
  return value;
}

function optionalCount(query: Record<string, unknown>, key: string, min: number): number | undefined {
  const value = query[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new QueryRejectedError(`"${key}" must be a whole number of at least ${min}.`);
  }
  return value;
}

/**
 * Validates a structured Mongo request and decodes its Extended JSON values (`$date`,
 * `$oid`, `$numberDecimal`...). Throws QueryRejectedError for anything else.
 */
export function parseMongoQuery(query: DriverQuery): MongoQuery {
  if (!isPlainObject(query)) {
    throw new QueryRejectedError(
      'MongoDB Data Sources take a JSON object: {"find": "<collection>", ...} or {"aggregate": "<collection>", "pipeline": [...]}.',
    );
  }
  assertNoForbiddenOperators(query);
  const decoded = BSON.EJSON.deserialize(query as Document, { relaxed: true }) as Record<string, unknown>;
  const keys = Object.keys(decoded);

  if ('find' in decoded && !('aggregate' in decoded)) {
    const unknown = keys.filter((k) => !FIND_KEYS.has(k));
    if (unknown.length) throw new QueryRejectedError(`Unsupported find option(s): ${unknown.join(', ')}.`);
    return {
      kind: 'find',
      collection: collectionName(decoded.find, 'find'),
      filter: optionalObject(decoded, 'filter') ?? {},
      projection: optionalObject(decoded, 'projection'),
      sort: optionalObject(decoded, 'sort'),
      skip: optionalCount(decoded, 'skip', 0),
      limit: optionalCount(decoded, 'limit', 1),
    };
  }
  if ('aggregate' in decoded && !('find' in decoded)) {
    const unknown = keys.filter((k) => !AGGREGATE_KEYS.has(k));
    if (unknown.length) throw new QueryRejectedError(`Unsupported aggregate option(s): ${unknown.join(', ')}.`);
    const pipeline = decoded.pipeline ?? [];
    if (!Array.isArray(pipeline) || !pipeline.every(isPlainObject)) {
      throw new QueryRejectedError('"pipeline" must be an array of stage objects.');
    }
    for (const stage of pipeline) {
      const stageKeys = Object.keys(stage);
      if (stageKeys.length !== 1 || !stageKeys[0]!.startsWith('$')) {
        throw new QueryRejectedError(`Each pipeline stage must have exactly one $operator key, got: ${stageKeys.join(', ')}.`);
      }
    }
    return { kind: 'aggregate', collection: collectionName(decoded.aggregate, 'aggregate'), pipeline };
  }
  throw new QueryRejectedError('A MongoDB query must have exactly one of "find" or "aggregate".');
}

// ---------------------------------------------------------------------------------------
// Flattening documents into columns and rows
// ---------------------------------------------------------------------------------------

interface BsonValue {
  _bsontype: string;
}

function bsonType(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && '_bsontype' in value
    ? (value as BsonValue)._bsontype
    : undefined;
}

/** Numbers as JS numbers only when that is exact; otherwise the decimal text. */
function exactNumber(text: string): number | string {
  const value = Number(text);
  if (!Number.isFinite(value)) return text;
  if (/^-?\d+$/.test(text)) return Number.isSafeInteger(value) ? value : text;
  const digits = text.replace(/^-/, '').replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  return digits.length <= 15 ? value : text;
}

interface Converted {
  value: unknown;
  /** BSON type name, as `$type` reports it. */
  native: string;
  type: ColumnType;
}

/** Turns one BSON value (read with promoteValues: false) into a JSON-friendly value. */
function convert(value: unknown): Converted {
  if (value === null || value === undefined) return { value: null, native: 'null', type: 'other' };
  if (typeof value === 'string') return { value, native: 'string', type: 'string' };
  if (typeof value === 'boolean') return { value, native: 'bool', type: 'boolean' };
  if (typeof value === 'number') {
    return { value, native: 'double', type: Number.isInteger(value) ? 'integer' : 'number' };
  }
  if (value instanceof Date) return { value, native: 'date', type: 'datetime' };
  if (Array.isArray(value)) return { value: value.map((v) => convert(v).value), native: 'array', type: 'json' };

  const v = value as Record<string, unknown> & { toString(): string };
  switch (bsonType(value)) {
    case 'Int32':
      return { value: Number(v.value), native: 'int', type: 'integer' };
    case 'Double':
      return { value: Number(v.value), native: 'double', type: 'number' };
    case 'Long': {
      const text = v.toString();
      return { value: exactNumber(text), native: 'long', type: 'integer' };
    }
    case 'Decimal128':
      return { value: exactNumber(v.toString()), native: 'decimal', type: 'number' };
    case 'ObjectId':
      return { value: (value as { toHexString(): string }).toHexString(), native: 'objectId', type: 'string' };
    case 'Binary': {
      const binary = value as { sub_type: number; toUUID(): { toHexString(): string }; toString(enc: string): string };
      if (binary.sub_type === 4) return { value: binary.toUUID().toHexString(), native: 'binData', type: 'string' };
      return { value: binary.toString('base64'), native: 'binData', type: 'other' };
    }
    case 'Timestamp': {
      const ts = value as { t: number; i: number };
      return { value: { t: ts.t, i: ts.i }, native: 'timestamp', type: 'json' };
    }
    case undefined:
      if (isPlainObject(value)) {
        const out: Record<string, unknown> = {};
        for (const [k, inner] of Object.entries(value)) out[k] = convert(inner).value;
        return { value: out, native: 'object', type: 'json' };
      }
      return { value: String(value), native: 'unknown', type: 'other' };
    default:
      return { value: v.toString(), native: bsonType(value)!.toLowerCase(), type: 'other' };
  }
}

/**
 * The flattening rule: every field becomes a column named by its path. Non-empty
 * subdocuments are flattened recursively into dotted paths (`address.city`); arrays, empty
 * subdocuments and scalar values are leaves (arrays and objects as JSON values).
 */
export function flattenDocument(doc: Document, prefix = '', out = new Map<string, Converted>()) {
  for (const [key, value] of Object.entries(doc)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value) && bsonType(value) === undefined && Object.keys(value).length > 0) {
      flattenDocument(value, path, out);
    } else {
      out.set(path, convert(value));
    }
  }
  return out;
}

/** One column's type across many documents: one type wins; integers mixed with numbers are numbers. */
function mergeTypes(types: Set<ColumnType>): ColumnType {
  if (types.size === 1) return [...types][0]!;
  if (types.size === 2 && types.has('integer') && types.has('number')) return 'number';
  return 'other';
}

interface ColumnStats {
  types: Set<ColumnType>;
  natives: Set<string>;
  seen: number;
  nulls: number;
}

/**
 * Flattens documents into a table. Columns appear in the order their paths first appear
 * across the documents (`_id` first when present); a document without a column has null.
 */
function tabulate(docs: Document[]) {
  const stats = new Map<string, ColumnStats>();
  const flat = docs.map((doc) => {
    const fields = flattenDocument(doc);
    for (const [path, c] of fields) {
      let s = stats.get(path);
      if (!s) stats.set(path, (s = { types: new Set(), natives: new Set(), seen: 0, nulls: 0 }));
      s.seen++;
      if (c.value === null) s.nulls++;
      else {
        s.types.add(c.type);
        s.natives.add(c.native);
      }
    }
    return fields;
  });
  const names = [...stats.keys()];
  if (names.includes('_id')) names.unshift(...names.splice(names.indexOf('_id'), 1));
  const columns = names.map((name) => {
    const s = stats.get(name)!;
    return {
      name,
      type: s.types.size ? mergeTypes(s.types) : ('other' as ColumnType),
      nativeType: s.natives.size ? [...s.natives].join('|') : 'null',
      nullable: s.nulls > 0 || s.seen < docs.length,
    };
  });
  const rows = flat.map((fields) => names.map((name) => fields.get(name)?.value ?? null));
  return { columns, rows };
}

// ---------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------

/** Server error codes for a query cancelled by maxTimeMS, and for a failed login. */
const TIME_LIMIT_CODES = new Set([50, 262]); // MaxTimeMSExpired, ExceededTimeLimit
const AUTH_FAILED = 18;

function readableConnectionError(error: unknown): string {
  const e = error as Error & { code?: number };
  if (e instanceof MongoServerError && e.code === AUTH_FAILED) return `The server refused the login: ${e.message}.`;
  if (e.name === 'MongoServerSelectionError') return `Could not reach MongoDB: ${e.message}.`;
  if (e.name === 'MongoParseError' || e.name === 'MongoAPIError') return `The connection string is invalid: ${e.message}.`;
  return e.message || String(error);
}

const READ_OPTIONS = { promoteValues: false } as const;

export function createMongoDriver(connection: MongoConnection, options: MongoDriverOptions = {}): DataSourceDriver {
  let client: MongoClient | undefined;

  /** Created lazily: an invalid connection string must not throw from the factory. */
  function db() {
    client ??= new MongoClient(connection.uri, {
      appName: 'bibot',
      maxPoolSize: 3,
      serverSelectionTimeoutMS: options.serverSelectionTimeoutMs ?? 10_000,
    });
    return client.db(connection.database);
  }

  async function run<T>(timeoutMs: number, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof QueryRejectedError) throw error;
      if (error instanceof MongoServerError) {
        if (TIME_LIMIT_CODES.has(Number(error.code))) throw new QueryTimeoutError(timeoutMs);
        if (error.code !== AUTH_FAILED) throw new QueryFailedError(error.message);
      }
      throw new QueryFailedError(readableConnectionError(error));
    }
  }

  return {
    dialect: MONGO_DIALECT,

    async testConnection() {
      try {
        await db().command({ ping: 1 });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: readableConnectionError(error) };
      }
    },

    async introspect() {
      const maxTimeMS = DEFAULT_QUERY_LIMITS.timeoutMs;
      const size = options.sampleSize ?? 100;
      return run(maxTimeMS, async () => {
        const database = db();
        const collections = await database.listCollections({}, { maxTimeMS }).toArray();
        const datasets: IntrospectedDataset[] = [];
        for (const info of collections) {
          if (info.name.startsWith('system.')) continue;
          const sample = await database
            .collection(info.name)
            // Sorted so the column order does not change from one random sample to the next.
            .aggregate([{ $sample: { size } }, { $sort: { _id: 1 } }], { maxTimeMS, ...READ_OPTIONS })
            .toArray();
          const columns: Column[] = tabulate(sample).columns;
          datasets.push({
            id: info.name,
            name: info.name,
            schema: null,
            kind: info.type === 'view' ? 'view' : 'collection',
            columns,
          });
        }
        return datasets.sort((a, b) => a.name.localeCompare(b.name));
      });
    },

    async execute(query, limits) {
      const parsed = parseMongoQuery(query);
      const { timeoutMs, maxRows } = { ...DEFAULT_QUERY_LIMITS, ...limits };
      const maxTimeMS = Math.max(1, Math.floor(timeoutMs));
      const fetch = Math.floor(maxRows) + 1;
      const started = performance.now();

      const docs = await run(timeoutMs, () => {
        const collection = db().collection(parsed.collection);
        if (parsed.kind === 'find') {
          return collection
            .find(parsed.filter, {
              projection: parsed.projection,
              sort: parsed.sort,
              skip: parsed.skip,
              limit: Math.min(parsed.limit ?? fetch, fetch),
              maxTimeMS,
              ...READ_OPTIONS,
            })
            .toArray();
        }
        return collection.aggregate([...parsed.pipeline, { $limit: fetch }], { maxTimeMS, ...READ_OPTIONS }).toArray();
      });

      const truncated = docs.length > maxRows;
      const { columns, rows } = tabulate(truncated ? docs.slice(0, maxRows) : docs);
      return {
        columns: columns.map(({ name, type }): ResultColumn => ({ name, type })),
        rows,
        truncated,
        durationMs: Math.round(performance.now() - started),
      };
    },

    async close() {
      await client?.close();
    },
  };
}

const mongoConfigSchema = z.object({
  database: z.string().trim().min(1, 'Database is required'),
});

const mongoSecretsSchema = z.object({
  connectionString: z
    .string({ error: 'Connection string is required' })
    .trim()
    .regex(/^mongodb(\+srv)?:\/\//, 'Use a mongodb:// or mongodb+srv:// connection string'),
});

export const mongoKind: DriverKind<z.infer<typeof mongoConfigSchema>, z.infer<typeof mongoSecretsSchema>> = {
  kind: 'mongodb',
  label: 'MongoDB',
  fields: [
    {
      key: 'connectionString',
      label: 'Connection string',
      input: 'password',
      secret: true,
      required: true,
      help: 'mongodb:// or mongodb+srv:// URI. Use a user with only the built-in "read" role on this database.',
    },
    { key: 'database', label: 'Database', input: 'text', required: true },
  ],
  configSchema: mongoConfigSchema,
  secretsSchema: mongoSecretsSchema,
  create: (config, secrets) => createMongoDriver({ uri: secrets.connectionString, database: config.database }),
};
