/**
 * The Answer and Result Block model. An Answer is the agent's reply to one Prompt: an ordered
 * list of Result Blocks, the Data Sources and Datasets it used, every query it executed
 * (successful or not), token usage and timing. Transports (web, Slack) only render this model.
 *
 * Result Block kinds: Text, Table and Chart. Files (CSV/XLSX) are generated from Table blocks
 * when a transport needs them (see `src/core/files`). Renderers should ignore kinds they don't know.
 */
import type { Dialect, ResultColumn } from '../data-sources/driver';

export interface TextBlock {
  type: 'text';
  /** Markdown. */
  markdown: string;
}

export interface TableBlock {
  type: 'table';
  title?: string;
  /**
   * The query result this table shows (`ExecutedQuery.resultId`), with `columns` naming the
   * selected columns in order. Lets Pinned Queries rebuild the block from fresh rows.
   * Missing on Answers stored before Pinned Queries existed.
   */
  resultId?: string;
  columns: ResultColumn[];
  /** One array per row, values in `columns` order. At most `TABLE_BLOCK_MAX_ROWS`. */
  rows: unknown[][];
  /** True when the query hit its row cap, or the rows were cut to `TABLE_BLOCK_MAX_ROWS`. */
  truncated: boolean;
}

/** The six chart kinds, named from the spec's mark (arc = pie/donut, point = scatter, text = big number). */
export type ChartKind = 'bar' | 'line' | 'area' | 'pie' | 'scatter' | 'big-number';

/** A single-view Vega-Lite spec without data, theme or size (see `src/core/charts/chart.ts`). */
export type ChartSpec = Record<string, unknown>;

export interface ChartBlock {
  type: 'chart';
  kind: ChartKind;
  title?: string;
  /** The query result the chart draws (`ExecutedQuery.resultId`); lets Pinned Queries rebuild it. */
  resultId: string;
  spec: ChartSpec;
  /** The result's rows as objects keyed by column name. At most `CHART_MAX_ROWS`. */
  data: Record<string, unknown>[];
  truncated: boolean;
}

export type ResultBlock = TextBlock | TableBlock | ChartBlock;

/** Rows kept in a Table block (the Answer is one Mongo document, so it has to stay small). */
export const TABLE_BLOCK_MAX_ROWS = 1_000;

/** One query the agent ran while answering. Powers "show query" and, later, Pinned Queries. */
export interface ExecutedQuery {
  /** The name the agent gave the result (`resultId` in tools); unique within the Answer. */
  resultId: string;
  dataSourceId: string;
  dataSourceName: string;
  language: Dialect['language'];
  /** Exactly what was sent to the driver (SQL/SOQL text, or the Mongo request as JSON). */
  query: string;
  ok: boolean;
  /** The driver's message when `ok` is false; it was returned to the model. */
  error?: string;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

/** A Data Source the Answer used, with the Datasets its queries referred to. */
export interface AnswerSource {
  dataSourceId: string;
  name: string;
  /** Dataset ids, e.g. `public.orders`. */
  datasets: string[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface Answer {
  /** `failed`: the agent could not finish; `error` holds a message safe to show the user. */
  status: 'complete' | 'failed';
  error?: string;
  blocks: ResultBlock[];
  sources: AnswerSource[];
  queries: ExecutedQuery[];
  usage: TokenUsage;
  startedAt: Date;
  finishedAt: Date;
}

/**
 * Progress while an Answer is being made, in order. Web streams these to the browser;
 * Slack updates its placeholder message with `progress` labels.
 */
export type AnswerEvent =
  | { type: 'progress'; label: string }
  | { type: 'query'; query: ExecutedQuery }
  | { type: 'block'; block: ResultBlock };
