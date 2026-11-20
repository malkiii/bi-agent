/**
 * Slack rendering: pure functions from the Answer model to Block Kit, plus the Prompt text
 * clean-up for incoming Slack messages. No I/O here, so later Result Blocks (Chart as PNG,
 * File attachments) extend `renderAnswer` and its tests.
 *
 * Slack limits that shape this module: 50 blocks per message, 3 000 chars per mrkdwn section,
 * Table blocks of at most 100 rows / 20 columns / 10 000 chars, and one Table block per message
 * (later tables are shown as monospaced text).
 */
import type { Answer, ExecutedQuery, TableBlock } from '../conversations/answer';

/** Rows shown inline in Slack; the rest is summarised ("Showing 15 of 40 rows."). */
export const SLACK_INLINE_TABLE_ROWS = 15;
export const SHOW_QUERY_ACTION_ID = 'show_query';

const MAX_BLOCKS = 50;
const MAX_SECTION_CHARS = 3_000;
const MAX_TABLE_COLUMNS = 20;
const MAX_CELL_CHARS = 200;
const MAX_MODAL_BLOCKS = 100;

/** A Block Kit block. Kept loose on purpose: the gateway forwards it to Slack as-is. */
export type SlackBlock = Record<string, unknown>;

export interface RenderedMessage {
  /** Notification / accessibility fallback. */
  text: string;
  blocks: SlackBlock[];
}

const section = (text: string): SlackBlock => ({ type: 'section', text: { type: 'mrkdwn', text } });
const context = (text: string): SlackBlock => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

/** The final Answer message. `answerId` goes into the "Show query" button. */
export function renderAnswer(answer: Answer, { answerId }: { answerId: string }): RenderedMessage {
  if (answer.status === 'failed') return renderFailure(answer.error ?? 'Sorry, something went wrong.');

  const blocks: SlackBlock[] = [];
  let tableBlockUsed = false;
  for (const block of answer.blocks) {
    switch (block.type) {
      case 'text':
        blocks.push(...splitSections(toMrkdwn(block.markdown)));
        break;
      case 'table':
        blocks.push(...renderTable(block, !tableBlockUsed));
        tableBlockUsed = true;
        break;
      default:
        break; // Unknown Result Block kinds are skipped.
    }
  }

  const footer: SlackBlock[] = [];
  if (answer.sources.length > 0) {
    const names = answer.sources.map((s) => (s.datasets.length ? `${s.name} (${s.datasets.join(', ')})` : s.name));
    footer.push(context(`Sources: ${escape(names.join('; '))}`));
  }
  if (answer.queries.length > 0) {
    footer.push({
      type: 'actions',
      elements: [
        { type: 'button', action_id: SHOW_QUERY_ACTION_ID, text: { type: 'plain_text', text: 'Show query' }, value: answerId },
      ],
    });
  }

  const body = blocks.slice(0, MAX_BLOCKS - footer.length);
  if (body.length === 0) body.push(section('_(No result to show.)_'));
  return { text: fallbackText(answer), blocks: [...body, ...footer] };
}

/** The "Show query" modal: every executed query with its Data Source and outcome. */
export function renderQueryModal(answer: Answer): SlackBlock {
  const blocks = answer.queries.flatMap((q) => [section(queryHeading(q)), section(codeBlock(q.query))]);
  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'Queries' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: blocks.length ? blocks.slice(0, MAX_MODAL_BLOCKS) : [section('No queries were run for this Answer.')],
  };
}

/** A readable error in place of the Answer. */
export function renderFailure(message: string): RenderedMessage {
  return { text: message, blocks: [section(`:x: ${escape(message)}`)] };
}

export const PLACEHOLDER_TEXT = ':hourglass_flowing_sand: Thinking…';

/** The placeholder reply while the agent works, showing the latest `progress` label. */
export function renderProgress(label: string): RenderedMessage {
  const text = `:hourglass_flowing_sand: ${label}`;
  return { text, blocks: [context(escape(text))] };
}

function queryHeading(q: ExecutedQuery): string {
  const language = q.language.toUpperCase();
  const outcome = q.ok ? `${q.rowCount}${q.truncated ? '+' : ''} ${q.rowCount === 1 ? 'row' : 'rows'}` : `failed: ${q.error ?? 'error'}`;
  return `*${escape(q.dataSourceName)}* · ${language} · ${escape(outcome)}`;
}

function codeBlock(text: string): string {
  const max = MAX_SECTION_CHARS - 10;
  const body = text.length > max ? `${text.slice(0, max - 1)}…` : text;
  return `\`\`\`\n${escape(body).replaceAll('```', "'''")}\n\`\`\``;
}

function renderTable(table: TableBlock, asTableBlock: boolean): SlackBlock[] {
  const columns = table.columns.slice(0, MAX_TABLE_COLUMNS);
  const rows = table.rows.slice(0, SLACK_INLINE_TABLE_ROWS).map((r) => r.slice(0, columns.length));
  const out: SlackBlock[] = [];
  const title = table.title ? `*${escape(table.title)}*` : '';

  if (asTableBlock) {
    if (title) out.push(section(title));
    out.push({
      type: 'table',
      column_settings: columns.map((c) => ({ align: isNumeric(c.type) ? 'right' : 'left' })),
      rows: [columns.map((c) => rawText(c.name)), ...rows.map((r) => r.map(cell))],
    });
  } else {
    out.push(section([title, codeBlock(monospaced(columns.map((c) => c.name), rows))].filter(Boolean).join('\n')));
  }

  const total = table.rows.length;
  if (total > rows.length || table.truncated) {
    out.push(context(`Showing ${rows.length} of ${total}${table.truncated ? '+' : ''} rows.`));
  }
  return out;
}

function isNumeric(type: string) {
  return type === 'integer' || type === 'number';
}

function rawText(text: string): SlackBlock {
  return { type: 'raw_text', text: text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS - 1)}…` : text };
}

function cell(value: unknown): SlackBlock {
  if (typeof value === 'number' && Number.isFinite(value)) return { type: 'raw_number', value };
  return rawText(formatValue(value));
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function monospaced(header: string[], rows: unknown[][]): string {
  const lines = [header, ...rows.map((r) => r.map((v) => formatValue(v).slice(0, MAX_CELL_CHARS)))];
  const widths = header.map((_, i) => Math.max(...lines.map((l) => (l[i] ?? '').length)));
  const format = (l: string[]) =>
    l
      .map((v, i) => v.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [format(lines[0]!), widths.map((w) => '-'.repeat(w)).join('  '), ...lines.slice(1).map(format)].join('\n');
}

function splitSections(text: string): SlackBlock[] {
  const out: SlackBlock[] = [];
  let rest = text;
  while (rest.length > MAX_SECTION_CHARS) {
    const cut = rest.lastIndexOf('\n', MAX_SECTION_CHARS);
    const at = cut > MAX_SECTION_CHARS / 2 ? cut : MAX_SECTION_CHARS;
    out.push(section(rest.slice(0, at)));
    rest = rest.slice(at).replace(/^\n/, '');
  }
  if (rest.trim()) out.push(section(rest));
  return out;
}

function fallbackText(answer: Answer): string {
  const first = answer.blocks.find((b) => b.type === 'text');
  const text = first ? toMrkdwn(first.markdown) : "Here's your Answer.";
  return text.length > MAX_SECTION_CHARS ? `${text.slice(0, MAX_SECTION_CHARS - 1)}…` : text;
}

/** Escapes the three characters Slack treats as markup. */
function escape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Markdown (from the model) to Slack mrkdwn. Code spans and fences are left untouched. */
export function toMrkdwn(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) => (i % 2 === 1 ? part : convertProse(part)))
    .join('');
}

function convertProse(text: string): string {
  const links: string[] = [];
  const BOLD = '\u0000B';
  let out = escape(text)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => {
      links.push(`<${url}|${label}>`);
      return `\u0000L${links.length - 1}\u0000`;
    })
    .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, `${BOLD}$1${BOLD}`)
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a?: string, b?: string) => `${BOLD}${a ?? b}${BOLD}`)
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1_$2_')
    .replace(/~~(.+?)~~/g, '~$1~')
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ');
  out = out.replaceAll(BOLD, '*');
  return out.replace(/\u0000L(\d+)\u0000/g, (_, i: string) => links[Number(i)] ?? '');
}

/**
 * Prompt text from a Slack message: drops the bot's own mention and turns Slack markup
 * (`<@U1>`, `<#C1|name>`, `<url|label>`, `&amp;`) into plain text for the model.
 */
export function cleanPromptText(text: string, botUserId?: string): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => (id === botUserId ? '' : `@${id}`))
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<#([A-Z0-9]+)>/g, '#$1')
    .replace(/<!(here|channel|everyone)[^>]*>/g, '@$1')
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
