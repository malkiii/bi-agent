import { describe, expect, test } from 'vitest';
import type { Answer, ExecutedQuery } from '@/core';
import type { ChartBlock } from '@/core';
import {
  OPEN_IN_DASHBOARD_ACTION_ID,
  SHOW_QUERY_ACTION_ID,
  cleanPromptText,
  renderAnswer,
  renderQueryModal,
  toMrkdwn,
} from './render';

const at = new Date('2026-01-05T09:00:00Z');

function answer(overrides: Partial<Answer> = {}): Answer {
  return {
    status: 'complete',
    blocks: [],
    sources: [],
    queries: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    startedAt: at,
    finishedAt: at,
    ...overrides,
  };
}

const query: ExecutedQuery = {
  resultId: 'north',
  dataSourceId: 'ds1',
  dataSourceName: 'Warehouse',
  language: 'sql',
  query: "SELECT region, sum(amount) FROM orders WHERE region = 'north' GROUP BY region",
  ok: true,
  rowCount: 1,
  truncated: false,
  durationMs: 12,
};

describe('renderAnswer', () => {
  test('a Text block becomes a mrkdwn section and the fallback text', () => {
    const { text, blocks } = renderAnswer(answer({ blocks: [{ type: 'text', markdown: 'North sold **17.75**.' }] }), {
      answerId: 'a1',
    });

    expect(text).toBe('North sold *17.75*.');
    expect(blocks).toEqual([{ type: 'section', text: { type: 'mrkdwn', text: 'North sold *17.75*.' } }]);
  });

  test('a small Table block renders inline with a header row, numbers as numbers', () => {
    const { blocks } = renderAnswer(
      answer({
        blocks: [
          {
            type: 'table',
            title: 'By region',
            columns: [
              { name: 'region', type: 'string' },
              { name: 'total', type: 'number' },
            ],
            rows: [
              ['north', 17.75],
              ['south', null],
            ],
            truncated: false,
          },
        ],
      }),
      { answerId: 'a1' },
    );

    expect(blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: '*By region*' } },
      {
        type: 'table',
        column_settings: [{ align: 'left' }, { align: 'right' }],
        rows: [
          [
            { type: 'raw_text', text: 'region' },
            { type: 'raw_text', text: 'total' },
          ],
          [
            { type: 'raw_text', text: 'north' },
            { type: 'raw_number', value: 17.75 },
          ],
          [
            { type: 'raw_text', text: 'south' },
            { type: 'raw_text', text: '' },
          ],
        ],
      },
    ]);
  });

  test('tables of up to 15 rows are shown whole, with nothing attached', () => {
    const rows = Array.from({ length: 15 }, (_, i) => [i]);
    const { blocks, uploads } = renderAnswer(
      answer({ blocks: [{ type: 'table', columns: [{ name: 'n', type: 'integer' }], rows, truncated: false }] }),
      { answerId: 'a1' },
    );

    const table = blocks.find((b) => (b as { type: string }).type === 'table') as { rows: unknown[][] };
    expect(table.rows).toHaveLength(16);
    expect(blocks.filter((b) => (b as { type: string }).type === 'context')).toEqual([]);
    expect(uploads).toEqual([]);
  });

  test('tables longer than 15 rows show a 10-row preview and attach the full table as CSV and XLSX', () => {
    const rows = Array.from({ length: 40 }, (_, i) => [i]);
    const block = { type: 'table' as const, title: 'Numbers', columns: [{ name: 'n', type: 'integer' as const }], rows, truncated: false };
    const { blocks, uploads } = renderAnswer(answer({ blocks: [block] }), { answerId: 'a1' });

    const table = blocks.find((b) => (b as { type: string }).type === 'table') as { rows: unknown[][] };
    expect(table.rows).toHaveLength(11);
    expect(blocks).toContainEqual({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Showing 10 of 40 rows. The full table is attached below as CSV and XLSX.' }],
    });
    expect(uploads).toEqual([{ kind: 'table', block }]);
  });

  test('a truncated query result says there were more rows', () => {
    const rows = Array.from({ length: 20 }, (_, i) => [i]);
    const { blocks } = renderAnswer(
      answer({ blocks: [{ type: 'table', columns: [{ name: 'n', type: 'integer' }], rows, truncated: true }] }),
      { answerId: 'a1' },
    );

    expect(blocks).toContainEqual({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Showing 10 of 20+ rows. The 20 rows Botley kept are attached below as CSV and XLSX.' }],
    });
  });

  test('a Chart block is named in the message and attached as an image', () => {
    const chart: ChartBlock = {
      type: 'chart',
      kind: 'bar',
      title: 'Sales <by> region',
      resultId: 'r',
      spec: { mark: 'bar', encoding: {} },
      data: [],
      truncated: false,
    };
    const { blocks, uploads } = renderAnswer(answer({ blocks: [chart] }), { answerId: 'a1' });

    expect(blocks).toEqual([
      { type: 'context', elements: [{ type: 'mrkdwn', text: ':bar_chart: *Sales &lt;by&gt; region* (chart attached below)' }] },
    ]);
    expect(uploads).toEqual([{ kind: 'chart', block: chart }]);
  });

  test('only the first table is a Table block; later ones are monospaced text', () => {
    const table = { type: 'table' as const, columns: [{ name: 'n', type: 'integer' as const }], rows: [[1], [22]], truncated: false };
    const { blocks } = renderAnswer(answer({ blocks: [table, { ...table, title: 'Again' }] }), { answerId: 'a1' });

    expect(blocks.filter((b) => (b as { type: string }).type === 'table')).toHaveLength(1);
    expect(blocks.at(-1)).toEqual({ type: 'section', text: { type: 'mrkdwn', text: '*Again*\n```\nn\n--\n1\n22\n```' } });
  });

  test('sources footer and a "Show query" button carrying the Answer id', () => {
    const { blocks } = renderAnswer(
      answer({
        blocks: [{ type: 'text', markdown: 'Hi' }],
        sources: [{ dataSourceId: 'ds1', name: 'Warehouse', datasets: ['public.orders', 'public.users'] }],
        queries: [query],
      }),
      { answerId: 'a1' },
    );

    expect(blocks.slice(1)).toEqual([
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Sources: Warehouse (public.orders, public.users)' }] },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: SHOW_QUERY_ACTION_ID,
            text: { type: 'plain_text', text: 'Show query' },
            value: 'a1',
          },
        ],
      },
    ]);
  });

  test('an "Open in dashboard" link button when the dashboard URL is known', () => {
    const { blocks } = renderAnswer(answer({ blocks: [{ type: 'text', markdown: 'Hi' }] }), {
      answerId: 'a1',
      dashboardUrl: 'https://botley.example/chat/fork/c1',
    });

    expect(blocks.at(-1)).toEqual({
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: OPEN_IN_DASHBOARD_ACTION_ID,
          text: { type: 'plain_text', text: 'Open in dashboard' },
          url: 'https://botley.example/chat/fork/c1',
        },
      ],
    });
  });

  test('block kinds it does not know are skipped', () => {
    const unknown = { type: 'hologram', spec: {} } as unknown as Answer['blocks'][number];
    const { blocks } = renderAnswer(answer({ blocks: [unknown, { type: 'text', markdown: 'Hi' }] }), { answerId: 'a1' });

    expect(blocks).toEqual([{ type: 'section', text: { type: 'mrkdwn', text: 'Hi' } }]);
  });

  test('a failed Answer shows its friendly error', () => {
    const { text, blocks } = renderAnswer(answer({ status: 'failed', error: 'Sorry, I could not answer that.' }), {
      answerId: 'a1',
    });

    expect(text).toBe('Sorry, I could not answer that.');
    expect(blocks).toEqual([{ type: 'section', text: { type: 'mrkdwn', text: ':x: Sorry, I could not answer that.' } }]);
  });
});

describe('renderQueryModal', () => {
  test('shows each executed query with its Data Source, language and outcome', () => {
    const failed: ExecutedQuery = { ...query, resultId: 'bad', query: 'SELECT nope', ok: false, error: 'column "nope" does not exist', rowCount: 0 };
    const view = renderQueryModal(answer({ queries: [query, failed] }));

    expect(view).toEqual({
      type: 'modal',
      title: { type: 'plain_text', text: 'Queries' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: '*Warehouse* · SQL · 1 row' } },
        { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`\n${query.query}\n\`\`\`` } },
        { type: 'section', text: { type: 'mrkdwn', text: '*Warehouse* · SQL · failed: column "nope" does not exist' } },
        { type: 'section', text: { type: 'mrkdwn', text: '```\nSELECT nope\n```' } },
      ],
    });
  });
});

describe('toMrkdwn', () => {
  test.each([
    ['**bold** and *italic*', '*bold* and _italic_'],
    ['# Revenue', '*Revenue*'],
    ['see [the docs](https://example.com)', 'see <https://example.com|the docs>'],
    ['- one\n- two', '• one\n• two'],
    ['a < b & c > d', 'a &lt; b &amp; c &gt; d'],
    ['`code` stays', '`code` stays'],
  ])('%s', (markdown, mrkdwn) => {
    expect(toMrkdwn(markdown)).toBe(mrkdwn);
  });
});

describe('cleanPromptText', () => {
  test('removes the bot mention and unwraps Slack markup', () => {
    expect(cleanPromptText('<@UBOT> sales in <#C1|finance> by <@U2>? see <https://x.io|x> &amp; more', 'UBOT')).toBe(
      'sales in #finance by @U2? see x (https://x.io) & more',
    );
  });
});
