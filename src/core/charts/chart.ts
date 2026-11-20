/**
 * Chart Result Blocks: what the agent may draw (a single-view Vega-Lite spec over one query
 * result), how a spec is checked, and the themed full spec that every renderer draws
 * (web with vega-embed, Slack/Report Runs as PNG via `png.ts`).
 *
 * Pure and dependency-free so the browser can import it too. The block stores the spec
 * without data plus the rows it draws; renderers inject the rows and the theme.
 */
import type { ChartBlock, ChartKind, ChartSpec } from '../conversations/answer';
import type { QueryResult, ResultColumn } from '../data-sources/driver';

/** Rows kept in a Chart block (same budget as a Table block). */
export const CHART_MAX_ROWS = 1_000;

const MARK_KINDS: Record<string, ChartKind> = {
  bar: 'bar',
  line: 'line',
  area: 'area',
  arc: 'pie',
  point: 'scatter',
  circle: 'scatter',
  square: 'scatter',
  text: 'big-number',
};

/** Top-level keys of a single-view spec. Data, composition and config are ours to set. */
const ALLOWED_KEYS = new Set(['$schema', 'mark', 'encoding', 'transform', 'description']);
/** Keys that could make a renderer fetch something or nest another view, anywhere in the spec. */
const FORBIDDEN_DEEP_KEYS = new Set(['url', 'href', 'data', 'datasets', 'image']);

export type ChartSpecCheck = { ok: true; kind: ChartKind; spec: ChartSpec } | { ok: false; error: string };

/**
 * Checks a spec the agent wrote against the result it should draw. Errors are written for
 * the model, so it can fix the spec and try again.
 */
export function checkChartSpec(input: unknown, columns: readonly ResultColumn[]): ChartSpecCheck {
  if (!isRecord(input)) return { ok: false, error: 'The spec must be a Vega-Lite JSON object.' };
  if ('data' in input || 'datasets' in input) {
    return { ok: false, error: 'Leave out "data": the chart is drawn from the resultId you pass.' };
  }
  const extra = Object.keys(input).filter((k) => !ALLOWED_KEYS.has(k));
  if (extra.length > 0) {
    return {
      ok: false,
      error: `Unsupported spec keys: ${extra.join(', ')}. Use one view with "mark", "encoding" and optionally "transform".`,
    };
  }
  const forbidden = findForbiddenKey(input);
  if (forbidden) return { ok: false, error: `"${forbidden}" is not allowed in a chart spec (no URLs, images or extra data).` };

  const markType = typeof input.mark === 'string' ? input.mark : isRecord(input.mark) ? input.mark.type : undefined;
  const kind = typeof markType === 'string' ? MARK_KINDS[markType] : undefined;
  if (!kind) {
    return {
      ok: false,
      error: `Unsupported mark "${String(markType)}". Use bar, line, area, arc (pie/donut), point (scatter) or text (big number).`,
    };
  }
  if (!isRecord(input.encoding)) return { ok: false, error: 'The spec needs an "encoding" object.' };

  const known = new Set([...columns.map((c) => c.name), ...transformOutputs(input.transform)]);
  const unknown = encodedFields(input.encoding).filter((f) => !known.has(f));
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown fields: ${unknown.join(', ')}. Columns: ${columns.map((c) => c.name).join(', ')}.` };
  }
  return { ok: true, kind, spec: input as ChartSpec };
}

/** The rows a chart draws: one object per row, numbers as numbers and dates as ISO strings. */
export function chartData(result: Pick<QueryResult, 'columns' | 'rows' | 'truncated'>): {
  data: Record<string, unknown>[];
  truncated: boolean;
} {
  const rows = result.rows.slice(0, CHART_MAX_ROWS);
  const data = rows.map((row) =>
    Object.fromEntries(result.columns.map((c, i) => [c.name, chartValue(row[i], c.type)])),
  );
  return { data, truncated: result.truncated || result.rows.length > CHART_MAX_ROWS };
}

function chartValue(value: unknown, type: string): unknown {
  if (value instanceof Date) return value.toISOString();
  if ((type === 'number' || type === 'integer') && typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (typeof value === 'bigint') return Number(value);
  return value;
}

/** A Chart block from a checked spec and the result it draws. */
export function chartBlock(
  result: Pick<QueryResult, 'columns' | 'rows' | 'truncated'>,
  check: Extract<ChartSpecCheck, { ok: true }>,
  resultId: string,
  title?: string,
): ChartBlock {
  return { type: 'chart', kind: check.kind, ...(title ? { title } : {}), resultId, spec: check.spec, ...chartData(result) };
}

// ---------------------------------------------------------------------------------------------
// Theme

/** Colours a chart is drawn with. Mirrors the neubrutalist tokens in src/app/globals.css. */
export interface ChartPalette {
  background: string;
  ink: string;
  muted: string;
  grid: string;
  /** Categorical colours, in order. */
  accents: string[];
  font: string;
}

const ACCENTS = ['#ffd23f', '#ff6b9d', '#3fd5ff', '#b8ff3f', '#ff9f1c', '#a78bfa', '#2ec4b6', '#f15bb5'];

export const LIGHT_CHART_PALETTE: ChartPalette = {
  background: '#ffffff',
  ink: '#111111',
  muted: '#555555',
  grid: '#dddddd',
  accents: ACCENTS,
  font: 'Space Grotesk',
};

export const DARK_CHART_PALETTE: ChartPalette = {
  background: '#1f1f1f',
  ink: '#f5f5f0',
  muted: '#b0b0a8',
  grid: '#3a3a3a',
  accents: ACCENTS,
  font: 'Space Grotesk',
};

export interface ChartViewOptions {
  palette: ChartPalette;
  /** Pixels, or 'container' to fill the parent (web). */
  width: number | 'container';
  height: number;
}

/** The full Vega-Lite spec to draw: the block's spec plus its rows, title, size and theme. */
export function chartViewSpec(block: ChartBlock, { palette, width, height }: ChartViewOptions): Record<string, unknown> {
  const p = palette;
  const bigNumber = block.kind === 'big-number';
  const markStroke = block.kind === 'bar' || block.kind === 'pie' || block.kind === 'area';
  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    ...block.spec,
    data: { values: block.data },
    ...(block.title ? { title: block.title } : {}),
    width,
    height,
    autosize: { type: 'fit', contains: 'padding' },
    background: p.background,
    padding: 12,
    config: {
      font: p.font,
      view: { stroke: null },
      title: { color: p.ink, fontSize: 16, fontWeight: 700, anchor: 'start', offset: 12 },
      axis: {
        domainColor: p.ink,
        domainWidth: 2,
        tickColor: p.ink,
        labelColor: p.ink,
        titleColor: p.ink,
        labelFontSize: 12,
        titleFontSize: 12,
        titleFontWeight: 700,
        gridColor: p.grid,
      },
      axisX: { labelAngle: 0, labelOverlap: 'greedy', labelLimit: 140 },
      legend: { labelColor: p.ink, titleColor: p.ink, labelFontSize: 12, titleFontSize: 12 },
      range: { category: p.accents },
      mark: { color: p.accents[0] },
      bar: markStroke ? { stroke: p.ink, strokeWidth: 2 } : {},
      arc: { stroke: p.ink, strokeWidth: 2 },
      area: { line: { color: p.ink, strokeWidth: 2 }, opacity: 0.85 },
      line: { strokeWidth: 3, color: p.ink },
      point: { filled: true, size: 80, stroke: p.ink, strokeWidth: 1.5 },
      text: bigNumber
        ? { fontSize: Math.min(72, Math.round(height / 2.5)), fontWeight: 700, color: p.ink, align: 'center', baseline: 'middle' }
        : { color: p.ink },
    },
  };
}

// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findForbiddenKey(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbiddenKey(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_DEEP_KEYS.has(key)) return key;
    if (key === 'type' && child === 'image') return 'image';
    const found = findForbiddenKey(child);
    if (found) return found;
  }
  return undefined;
}

/** Field names an encoding refers to (channel definitions, arrays of them, and conditions). */
function encodedFields(encoding: Record<string, unknown>): string[] {
  const fields: string[] = [];
  const visit = (def: unknown) => {
    if (Array.isArray(def)) return def.forEach(visit);
    if (!isRecord(def)) return;
    if (typeof def.field === 'string') fields.push(def.field);
    if (def.condition) visit(def.condition);
  };
  Object.values(encoding).forEach(visit);
  return [...new Set(fields)];
}

/** Field names transforms create (`as`), so encodings may use them. */
function transformOutputs(transform: unknown): string[] {
  if (!Array.isArray(transform)) return [];
  const out: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
  };
  for (const step of transform) {
    if (!isRecord(step)) continue;
    collect(step.as);
    for (const key of ['aggregate', 'window', 'joinaggregate'] as const) {
      const list = step[key];
      if (Array.isArray(list)) for (const item of list) if (isRecord(item)) collect(item.as);
    }
  }
  return out;
}
