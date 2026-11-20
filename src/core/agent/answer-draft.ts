import {
  TABLE_BLOCK_MAX_ROWS,
  type Answer,
  type AnswerEvent,
  type AnswerSource,
  type ExecutedQuery,
  type ResultBlock,
  type TokenUsage,
} from '../conversations/answer';
import type { QueryResult } from '../data-sources/driver';

/**
 * The Answer being built during one agent run. Tools write to it (blocks, queries, sources)
 * and it forwards each change as an `AnswerEvent`.
 */
export class AnswerDraft {
  private readonly blocks: ResultBlock[] = [];
  private readonly queries: ExecutedQuery[] = [];
  private readonly sources = new Map<string, AnswerSource>();
  private readonly results = new Map<string, QueryResult>();

  constructor(
    private readonly emit: (event: AnswerEvent) => void,
    readonly startedAt: Date,
  ) {}

  progress(label: string): void {
    this.emit({ type: 'progress', label });
  }

  addBlock(block: ResultBlock): void {
    this.blocks.push(block);
    this.emit({ type: 'block', block });
  }

  /** A result id that is unique within the Answer, based on the agent's suggested name. */
  newResultId(name?: string): string {
    const base = (name ?? '').trim().replace(/\s+/g, '_') || `result${this.queries.length + 1}`;
    let id = base;
    for (let n = 2; this.queries.some((q) => q.resultId === id); n++) id = `${base}_${n}`;
    return id;
  }

  /** Records an executed query; a successful one also keeps its rows for emit tools. */
  recordQuery(query: ExecutedQuery, result?: QueryResult): void {
    this.queries.push(query);
    if (result) this.results.set(query.resultId, result);
    this.emit({ type: 'query', query });
  }

  get failedQueryCount(): number {
    return this.queries.filter((q) => !q.ok).length;
  }

  result(resultId: string): QueryResult | undefined {
    return this.results.get(resultId);
  }

  resultIds(): string[] {
    return [...this.results.keys()];
  }

  /** Names a Data Source (and Datasets) as used by the Answer. */
  addSource(dataSourceId: string, name: string, datasets: readonly string[]): void {
    const source = this.sources.get(dataSourceId) ?? { dataSourceId, name, datasets: [] };
    for (const d of datasets) if (!source.datasets.includes(d)) source.datasets.push(d);
    this.sources.set(dataSourceId, source);
  }

  finish(outcome: { usage: TokenUsage; finishedAt: Date; error?: string }): Answer {
    return {
      status: outcome.error === undefined ? 'complete' : 'failed',
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      blocks: [...this.blocks],
      sources: [...this.sources.values()],
      queries: [...this.queries],
      usage: outcome.usage,
      startedAt: this.startedAt,
      finishedAt: outcome.finishedAt,
    };
  }
}

/** A Table block from a query result, cut to `TABLE_BLOCK_MAX_ROWS`. */
export function tableBlock(result: QueryResult, title?: string, resultId?: string): ResultBlock {
  return {
    type: 'table',
    ...(title ? { title } : {}),
    ...(resultId ? { resultId } : {}),
    columns: result.columns,
    rows: result.rows.slice(0, TABLE_BLOCK_MAX_ROWS),
    truncated: result.truncated || result.rows.length > TABLE_BLOCK_MAX_ROWS,
  };
}

/** The result with only the named columns, in that order. Names must exist. */
export function selectColumns(result: QueryResult, names: readonly string[]): QueryResult {
  const indexes = names.map((name) => result.columns.findIndex((c) => c.name === name));
  return {
    ...result,
    columns: indexes.map((i) => result.columns[i]!),
    rows: result.rows.map((row) => indexes.map((i) => row[i])),
  };
}
