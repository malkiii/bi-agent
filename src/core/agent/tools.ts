/**
 * The agent's built-in tools, grouped into toolkits. A toolkit is a factory that gets the
 * per-Answer context (catalog + Answer draft) and returns AI SDK tools plus optional
 * instructions for the model. To add a tool (emitChart, combineResults, ...), write a
 * toolkit and add it to `builtInToolkits`.
 */
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { AppError } from '../errors';
import type { AnswerDraft } from './answer-draft';
import { tableBlock } from './answer-draft';
import type { AgentCatalog, AgentDataSource } from './catalog';

export interface AgentToolContext {
  catalog: AgentCatalog;
  answer: AnswerDraft;
}

export interface AgentToolkit {
  /** Appended to the agent's instructions. */
  instructions?: string;
  tools: ToolSet;
}

export type AgentToolkitFactory = (ctx: AgentToolContext) => AgentToolkit;

/** Failed queries allowed per Answer before runQuery refuses to run more. */
export const MAX_FAILED_QUERIES = 4;
/** Rows of each result shown to the model (the full result stays in the Answer draft). */
export const MODEL_PREVIEW_ROWS = 20;

export const catalogToolkit: AgentToolkitFactory = ({ catalog, answer }) => ({
  tools: {
    listDatasets: tool({
      description:
        'List the Data Sources you can query, each with its query dialect and its Datasets (tables, collections, objects, sheets).',
      inputSchema: z.object({}),
      execute: async () => {
        answer.progress('Looking at the available Datasets…');
        const sources = await catalog.dataSources();
        return sources.map((ds) => ({
          dataSourceId: ds.dataSourceId,
          name: ds.name,
          dialect: ds.dialect,
          datasets: ds.datasets.map((d) => ({ id: d.id, kind: d.kind, columns: d.columns.map((c) => c.name) })),
        }));
      },
    }),
    describeDataset: tool({
      description: 'Get the detailed schema of one Dataset: every column with its type.',
      inputSchema: z.object({
        dataSourceId: z.string(),
        datasetId: z.string().describe('The Dataset id from listDatasets, e.g. public.orders'),
      }),
      execute: async ({ dataSourceId, datasetId }) => {
        const ds = await catalog.dataSource(dataSourceId);
        const dataset = ds?.datasets.find((d) => d.id === datasetId);
        if (!ds || !dataset) return { error: `Unknown Dataset "${datasetId}" in Data Source "${dataSourceId}".` };
        answer.progress(`Reading \`${dataset.name}\`…`);
        return {
          dataSourceId,
          id: dataset.id,
          kind: dataset.kind,
          columns: dataset.columns.map((c) => ({ name: c.name, type: c.type, nativeType: c.nativeType, nullable: c.nullable })),
        };
      },
    }),
  },
});

export const queryToolkit: AgentToolkitFactory = ({ catalog, answer }) => ({
  instructions:
    'Use runQuery to fetch data. Write the query in the Data Source dialect. If a query fails, read the error, fix the query and try again.',
  tools: {
    runQuery: tool({
      description:
        'Run one read-only query against a Data Source, written as its dialect guidance says. SQL and SOQL sources take query text; ' +
        'MongoDB sources take the JSON request as a string. Returns a resultId, the columns and a preview of the rows.',
      inputSchema: z.object({
        dataSourceId: z.string(),
        query: z.string(),
        name: z.string().optional().describe('A short name for the result, e.g. sales_by_region'),
      }),
      execute: async ({ dataSourceId, query, name }) => {
        const ds = await catalog.dataSource(dataSourceId);
        if (!ds) return { ok: false, error: `Unknown Data Source "${dataSourceId}". Call listDatasets.` };
        if (answer.failedQueryCount >= MAX_FAILED_QUERIES) {
          return { ok: false, error: 'Too many failed queries. Stop querying and tell the user what went wrong.' };
        }
        answer.progress(`Querying ${ds.name}…`);
        const resultId = answer.newResultId(name);
        const base = { resultId, dataSourceId, dataSourceName: ds.name, language: ds.dialect.language, query };
        try {
          const result = await catalog.execute(dataSourceId, parseQuery(ds, query));
          answer.recordQuery(
            { ...base, ok: true, rowCount: result.rows.length, truncated: result.truncated, durationMs: result.durationMs },
            result,
          );
          answer.addSource(ds.dataSourceId, ds.name, datasetsReferenced(ds, query));
          return {
            ok: true,
            resultId,
            columns: result.columns,
            rowCount: result.rows.length,
            truncated: result.truncated,
            rows: result.rows.slice(0, MODEL_PREVIEW_ROWS),
          };
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          answer.recordQuery({ ...base, ok: false, error: error.message, rowCount: 0, truncated: false, durationMs: 0 });
          const attemptsLeft = MAX_FAILED_QUERIES - answer.failedQueryCount;
          return { ok: false, error: error.message, attemptsLeft };
        }
      },
    }),
  },
});

export const emitToolkit: AgentToolkitFactory = ({ answer }) => ({
  instructions:
    'Build the Answer only with the emit tools, in reading order: emitText for prose (markdown), emitTable to show a query result. ' +
    'Do not repeat the Answer as plain text.',
  tools: {
    emitText: tool({
      description: 'Add a Text block (markdown) to the Answer.',
      inputSchema: z.object({ markdown: z.string() }),
      execute: async ({ markdown }) => {
        answer.addBlock({ type: 'text', markdown });
        return { ok: true };
      },
    }),
    emitTable: tool({
      description: 'Add a Table block to the Answer showing a runQuery result.',
      inputSchema: z.object({
        resultId: z.string().describe('The resultId returned by runQuery'),
        title: z.string().optional(),
      }),
      execute: async ({ resultId, title }) => {
        const result = answer.result(resultId);
        if (!result) return { ok: false, error: `Unknown resultId "${resultId}". Known: ${answer.resultIds().join(', ') || 'none'}.` };
        answer.addBlock(tableBlock(result, title));
        return { ok: true };
      },
    }),
  },
});

export const builtInToolkits: readonly AgentToolkitFactory[] = [catalogToolkit, queryToolkit, emitToolkit];

/** Mongo sources take a structured request; everything else takes the text as-is. */
function parseQuery(ds: AgentDataSource, query: string) {
  if (ds.dialect.language !== 'mongo') return query;
  let parsed: unknown;
  try {
    parsed = JSON.parse(query);
  } catch {
    throw new InvalidQueryError('The query must be a JSON object for a MongoDB Data Source.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidQueryError('The query must be a JSON object for a MongoDB Data Source.');
  }
  return parsed as Record<string, unknown>;
}

class InvalidQueryError extends AppError {
  constructor(message: string) {
    super('query_rejected', message);
  }
}

/**
 * Exposed Datasets the query mentions, matched by id or name as a whole word
 * (case-insensitive). Good enough to name sources; never used for access control.
 */
export function datasetsReferenced(ds: AgentDataSource, query: string): string[] {
  const text = query.toLowerCase();
  return ds.datasets
    .filter((d) => [d.id, d.name].some((term) => containsWord(text, term.toLowerCase())))
    .map((d) => d.id);
}

function containsWord(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w$])${escaped}($|[^\\w$])`).test(text);
}
