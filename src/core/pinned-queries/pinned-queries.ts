/**
 * Pinned Queries (ADR 0001): an Answer's successful queries and its block layout, stored so
 * they can be re-executed as-is through the drivers and the blocks rebuilt from the fresh
 * results, without asking the LLM again. Reports and KPIs both build on this.
 *
 *   const pinned = core.pinnedQueries.pin(answer);   // pure; store `pinned` in your own document
 *   const run = await core.pinnedQueries.run(pinned); // fresh rows, same layout
 *
 * Adding a Result Block type means adding an entry to `pinnableBlocks`; the
 * compiler insists, because the table is keyed by every `ResultBlock['type']`.
 */
import { selectColumns, tableBlock } from '../agent/answer-draft';
import { createAgentCatalog } from '../agent/catalog';
import { combineAll, datasetsReferenced, parseQuery } from '../agent/tools';
import { chartBlock, checkChartSpec } from '../charts/chart';
import type { Answer, AnswerSource, ChartBlock, ChartSpec, ExecutedQuery, ResultBlock, TableBlock, TextBlock } from '../conversations/answer';
import type { DataSources } from '../data-sources/data-sources';
import type { QueryResult } from '../data-sources/driver';
import { AppError, ValidationError } from '../errors';
import type { Clock, ResultCombiner } from '../ports';

/** One query the agent wrote, stored to be re-executed verbatim. */
export interface PinnedQuery {
  /** The id blocks use to refer to this query's result. */
  resultId: string;
  dataSourceId: string;
  /** The Data Source name when it was pinned (for display if the source is gone). */
  dataSourceName: string;
  language: ExecutedQuery['language'];
  /** Exactly what was sent to the driver (Mongo: the request as JSON), or the combineResults SQL. */
  query: string;
  /** A combineResults query: the resultIds it reads. It runs after them, on a temporary DuckDB. */
  combines?: string[];
}

/** A Result Block without its data: what it shows and which results it is built from. */
export type PinnedBlock =
  | { type: 'text'; markdown: string }
  | { type: 'table'; resultId: string; title?: string; /** Selected column names, in order. */ columns: string[] }
  | { type: 'chart'; resultId: string; title?: string; /** The Vega-Lite spec without data. */ spec: ChartSpec };

/** What gets stored: the queries plus the layout. Plain data, safe to keep in Mongo. */
export interface PinnedAnswer {
  queries: PinnedQuery[];
  layout: PinnedBlock[];
}

/** One rebuilt block, or why it could not be rebuilt (its query failed, a column vanished). */
export type PinnedRunBlock = { status: 'ok'; block: ResultBlock } | { status: 'error'; error: string; pinned: PinnedBlock };

export interface PinnedRun {
  /** `failed` when any Pinned Query or block failed; `error` then says which. */
  status: 'complete' | 'failed';
  error?: string;
  /** In layout order. */
  blocks: PinnedRunBlock[];
  /** Every Pinned Query as executed this time, failed ones too. */
  queries: ExecutedQuery[];
  sources: AnswerSource[];
  /** Full results of the successful queries by `resultId` (for KPIs, commentary). Not for storage. */
  results: Record<string, QueryResult>;
  startedAt: Date;
  finishedAt: Date;
}

export interface PinnedQueries {
  /**
   * Pins an Answer: its successful queries and its layout. Blocks that can't be rebuilt
   * (e.g. tables from Answers stored before Pinned Queries) are left out. ValidationError
   * when the Answer failed or has nothing to re-run.
   */
  pin(answer: Answer): PinnedAnswer;
  /** Executes the Pinned Queries and rebuilds the layout. Never asks the LLM; never rejects on query errors. */
  run(pinned: PinnedAnswer): Promise<PinnedRun>;
}

/** How a Result Block type is pinned and rebuilt. */
interface PinnableBlock<B extends ResultBlock, P extends PinnedBlock> {
  /** The pinned form, or null when the block can't be rebuilt. */
  pin(block: B): P | null;
  /** The `resultId`s the block is built from. */
  dependsOn(pinned: P): string[];
  /** Rebuilds the block; throws `PinnedBlockError` when the results no longer fit. */
  rebuild(pinned: P, results: Record<string, QueryResult>): ResultBlock;
}

type PinnableBlocks = {
  [K in ResultBlock['type']]: PinnableBlock<Extract<ResultBlock, { type: K }>, Extract<PinnedBlock, { type: K }>>;
};

export class PinnedBlockError extends AppError {
  constructor(message: string) {
    super('pinned_block_failed', message);
  }
}

const text: PinnableBlock<TextBlock, Extract<PinnedBlock, { type: 'text' }>> = {
  pin: (block) => ({ type: 'text', markdown: block.markdown }),
  dependsOn: () => [],
  rebuild: (pinned) => ({ type: 'text', markdown: pinned.markdown }),
};

const table: PinnableBlock<TableBlock, Extract<PinnedBlock, { type: 'table' }>> = {
  pin: (block) =>
    block.resultId
      ? {
          type: 'table',
          resultId: block.resultId,
          ...(block.title ? { title: block.title } : {}),
          columns: block.columns.map((c) => c.name),
        }
      : null,
  dependsOn: (pinned) => [pinned.resultId],
  rebuild(pinned, results) {
    const result = results[pinned.resultId]!;
    const missing = pinned.columns.find((name) => !result.columns.some((c) => c.name === name));
    if (missing) throw new PinnedBlockError(`The column "${missing}" is no longer in the result of "${pinned.resultId}".`);
    return tableBlock(selectColumns(result, pinned.columns), pinned.title, pinned.resultId);
  },
};

const chart: PinnableBlock<ChartBlock, Extract<PinnedBlock, { type: 'chart' }>> = {
  pin: (block) => ({ type: 'chart', resultId: block.resultId, ...(block.title ? { title: block.title } : {}), spec: block.spec }),
  dependsOn: (pinned) => [pinned.resultId],
  rebuild(pinned, results) {
    const result = results[pinned.resultId]!;
    const check = checkChartSpec(pinned.spec, result.columns);
    if (!check.ok) throw new PinnedBlockError(`The chart of "${pinned.resultId}" no longer fits its result: ${check.error}`);
    return chartBlock(result, check, pinned.resultId, pinned.title);
  },
};

const pinnableBlocks: PinnableBlocks = { text, table, chart };

/** The entry for a block or pinned block type, loosely typed for generic code. */
function kindOf(type: string): PinnableBlock<ResultBlock, PinnedBlock> | undefined {
  return (pinnableBlocks as Record<string, PinnableBlock<ResultBlock, PinnedBlock>>)[type];
}

export function pinAnswer(answer: Answer): PinnedAnswer {
  if (answer.status !== 'complete') throw new ValidationError('A failed Answer cannot be pinned.');
  const queries: PinnedQuery[] = answer.queries
    .filter((q) => q.ok)
    .map(({ resultId, dataSourceId, dataSourceName, language, query, combines }) => ({
      resultId,
      dataSourceId,
      dataSourceName,
      language,
      query,
      ...(combines ? { combines } : {}),
    }));
  const known = new Set(queries.map((q) => q.resultId));
  const layout = answer.blocks.flatMap((block) => {
    const kind = kindOf(block.type);
    const pinned = kind?.pin(block);
    if (!kind || !pinned || !kind.dependsOn(pinned).every((id) => known.has(id))) return [];
    return [pinned];
  });
  if (queries.length === 0 || !layout.some((b) => kindOf(b.type)!.dependsOn(b).length > 0)) {
    throw new ValidationError('This Answer has no query results to pin.');
  }
  return { queries, layout };
}

export function createPinnedQueries({
  dataSources,
  clock,
  combiner,
}: {
  dataSources: DataSources;
  clock: Clock;
  combiner?: ResultCombiner;
}): PinnedQueries {
  return {
    pin: pinAnswer,

    async run(pinned) {
      const startedAt = clock.now();
      const catalog = createAgentCatalog(dataSources);
      const results: Record<string, QueryResult> = {};
      const sources = new Map<string, AnswerSource>();

      const dataSourceQueries = await Promise.all(
        pinned.queries.filter((q) => !q.combines).map(async (q): Promise<ExecutedQuery> => {
          const base = { ...q, rowCount: 0, truncated: false, durationMs: 0 };
          const ds = await catalog.dataSource(q.dataSourceId);
          if (!ds) return { ...base, ok: false, error: `The Data Source "${q.dataSourceName}" is no longer available.` };
          try {
            const result = await catalog.execute(ds.dataSourceId, parseQuery(ds, q.query));
            results[q.resultId] = result;
            const source = sources.get(ds.dataSourceId) ?? { dataSourceId: ds.dataSourceId, name: ds.name, datasets: [] };
            for (const d of datasetsReferenced(ds, q.query)) if (!source.datasets.includes(d)) source.datasets.push(d);
            sources.set(ds.dataSourceId, source);
            return { ...base, dataSourceName: ds.name, ok: true, rowCount: result.rows.length, truncated: result.truncated, durationMs: result.durationMs };
          } catch (error) {
            return { ...base, ok: false, error: error instanceof AppError ? error.message : 'The query could not be run.' };
          }
        }),
      );

      // Combinations run in their recorded order, after the queries they read (which may be combinations too).
      const combined: ExecutedQuery[] = [];
      for (const q of pinned.queries.filter((p) => p.combines)) {
        const base = { ...q, rowCount: 0, truncated: false, durationMs: 0 };
        const missing = q.combines!.find((id) => !results[id]);
        if (missing) {
          combined.push({ ...base, ok: false, error: `It reads "${missing}", which has no result.` });
          continue;
        }
        if (!combiner) {
          combined.push({ ...base, ok: false, error: 'Combining results is not available.' });
          continue;
        }
        try {
          const inputs = Object.fromEntries(q.combines!.map((id) => [id, results[id]!]));
          const result = await combineAll(combiner, inputs, q.query);
          results[q.resultId] = result;
          combined.push({ ...base, ok: true, rowCount: result.rows.length, truncated: result.truncated, durationMs: result.durationMs });
        } catch (error) {
          combined.push({ ...base, ok: false, error: error instanceof AppError ? error.message : 'The query could not be run.' });
        }
      }
      const order = new Map(pinned.queries.map((q, i) => [q.resultId, i]));
      const queries = [...dataSourceQueries, ...combined].sort((a, b) => order.get(a.resultId)! - order.get(b.resultId)!);

      const failedQueries = new Map(queries.filter((q) => !q.ok).map((q) => [q.resultId, q.error ?? 'Failed.']));
      const blocks = pinned.layout.map((p): PinnedRunBlock => {
        const kind = kindOf(p.type);
        if (!kind) return { status: 'error', error: `Unknown block type "${p.type}".`, pinned: p };
        const failed = kind.dependsOn(p).find((id) => failedQueries.has(id) || !results[id]);
        if (failed) {
          return { status: 'error', error: `The Pinned Query "${failed}" failed: ${failedQueries.get(failed) ?? 'no result.'}`, pinned: p };
        }
        try {
          return { status: 'ok', block: kind.rebuild(p, results) };
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          return { status: 'error', error: error.message, pinned: p };
        }
      });

      const firstQueryError = queries.find((q) => !q.ok);
      const firstBlockError = blocks.find((b) => b.status === 'error');
      const error = firstQueryError
        ? `The Pinned Query "${firstQueryError.resultId}" failed: ${firstQueryError.error}`
        : firstBlockError?.status === 'error'
          ? firstBlockError.error
          : undefined;
      return {
        status: error ? 'failed' : 'complete',
        ...(error ? { error } : {}),
        blocks,
        queries,
        sources: [...sources.values()],
        results,
        startedAt,
        finishedAt: clock.now(),
      };
    },
  };
}
