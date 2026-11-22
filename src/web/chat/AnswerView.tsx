'use client';

import { useMemo, useState } from 'react';
import type { AnswerSource, ExecutedQuery, ResultBlock, TableBlock } from '@/core';
import { CopyButton } from '@/web/components/CopyButton';
import { ChartView } from './ChartView';
import { Markdown } from './Markdown';
import styles from './chat.module.css';

export interface AnswerViewProps {
  blocks: ResultBlock[];
  sources: AnswerSource[];
  queries: ExecutedQuery[];
  status?: 'complete' | 'failed' | 'pending';
  error?: string;
  /** Latest progress label while the Answer is being made. */
  progress?: string;
  /** The stored Answer message id, once known; tables then offer CSV/XLSX downloads. */
  messageId?: string;
}

/** One Answer: its Result Blocks, the Data Sources used and a "show query" toggle. */
export function AnswerView({ blocks, sources, queries, status = 'complete', error, progress, messageId }: AnswerViewProps) {
  const [showQueries, setShowQueries] = useState(false);
  const copyText = status === 'complete' ? answerText(blocks) : '';
  return (
    <article className={`card ${styles.answer}`} aria-busy={status === 'pending'}>
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} download={messageId ? `/api/answers/${messageId}/blocks/${i}` : undefined} />
      ))}
      {status === 'pending' && <p className={styles.progress}>{progress ?? 'Thinking…'}</p>}
      {status === 'failed' && (
        <p className={styles.error} role="alert">
          {error ?? 'Something went wrong.'}
        </p>
      )}
      {(sources.length > 0 || queries.length > 0 || copyText) && (
        <footer className={styles.answerFooter}>
          {copyText && <CopyButton text={copyText} label="Copy answer" />}
          {sources.length > 0 && (
            <p className={styles.sources}>
              <span>Sources:</span>{' '}
              {sources.map((s) => (
                <span key={s.dataSourceId} className="tag">
                  {s.name}
                  {s.datasets.length > 0 && ` · ${s.datasets.join(', ')}`}
                </span>
              ))}
            </p>
          )}
          {queries.length > 0 && (
            <button
              type="button"
              className="btn btn--ghost"
              aria-expanded={showQueries}
              onClick={() => setShowQueries((v) => !v)}
            >
              {showQueries ? 'Hide query' : 'Show query'}
              {queries.length > 1 && ` (${queries.length})`}
            </button>
          )}
          {showQueries && (
            <ol className={styles.queries}>
              {queries.map((q, i) => (
                <QueryView key={i} query={q} />
              ))}
            </ol>
          )}
        </footer>
      )}
    </article>
  );
}

/**
 * One Result Block; unknown block types render nothing. `download` is the URL a stored
 * Table block can be downloaded from (`?format=csv|xlsx`).
 */
export function BlockView({ block, download }: { block: ResultBlock; download?: string }) {
  switch (block.type) {
    case 'text':
      return (
        <div className={styles.text}>
          <Markdown text={block.markdown} />
        </div>
      );
    case 'table':
      return <TableView block={block} download={download} />;
    case 'chart':
      return <ChartView block={block} />;
    default:
      return null;
  }
}

function QueryView({ query }: { query: ExecutedQuery }) {
  return (
    <li className={styles.query}>
      <div className={styles.queryHead}>
        <p className={styles.queryMeta}>
          <strong>{query.dataSourceName}</strong> · {query.language.toUpperCase()} ·{' '}
          {query.ok ? `${query.rowCount} row${query.rowCount === 1 ? '' : 's'}${query.truncated ? ' (truncated)' : ''}` : 'failed'}
        </p>
        <CopyButton text={query.query} label="Copy query" />
      </div>
      <pre className={styles.queryText}>{query.query}</pre>
      {!query.ok && query.error && <p className={styles.queryError}>{query.error}</p>}
    </li>
  );
}

type Sort = { column: number; direction: 1 | -1 } | null;

function TableView({ block, download }: { block: TableBlock; download?: string }) {
  const [sort, setSort] = useState<Sort>(null);
  const rows = useMemo(() => {
    if (!sort) return block.rows;
    return [...block.rows].sort((a, b) => compare(a[sort.column], b[sort.column]) * sort.direction);
  }, [block.rows, sort]);

  function toggle(column: number) {
    setSort((s) => (s?.column === column ? (s.direction === 1 ? { column, direction: -1 } : null) : { column, direction: 1 }));
  }

  return (
    <figure className={styles.table}>
      {block.title && <figcaption>{block.title}</figcaption>}
      <div className={styles.tableScroll}>
        <table>
          <thead>
            <tr>
              {block.columns.map((c, i) => (
                <th
                  key={i}
                  aria-sort={sort?.column === i ? (sort.direction === 1 ? 'ascending' : 'descending') : 'none'}
                  className={isNumeric(c.type) ? styles.numeric : undefined}
                >
                  <button type="button" onClick={() => toggle(i)}>
                    {c.name}
                    {sort?.column === i ? (sort.direction === 1 ? ' ▲' : ' ▼') : ''}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((value, i) => (
                  <td key={i} className={isNumeric(block.columns[i]?.type) ? styles.numeric : undefined}>
                    {format(value)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.tableFooter}>
        {block.truncated && <p className={styles.truncated}>Showing the first {block.rows.length} rows.</p>}
        <p className={styles.downloads}>
          <CopyButton text={tableText(block)} label="Copy table" />
          {download && (
            <>
              <span>Download {block.rows.length.toLocaleString()} rows:</span>
              <a className="btn btn--ghost btn--sm" href={`${download}?format=csv`} download>
                CSV
              </a>
              <a className="btn btn--ghost btn--sm" href={`${download}?format=xlsx`} download>
                XLSX
              </a>
            </>
          )}
        </p>
      </div>
    </figure>
  );
}

/** The Answer as plain text to paste elsewhere: text as Markdown, tables as tab-separated rows. */
function answerText(blocks: ResultBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'text') return block.markdown.trim();
      if (block.type === 'table') return [block.title, tableText(block)].filter(Boolean).join('\n');
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/** A table as tab-separated values with a header row, which spreadsheets paste as cells. */
function tableText(block: TableBlock): string {
  const cell = (value: unknown) => (value === null || value === undefined ? '' : format(value).replace(/[\t\r\n]+/g, ' '));
  const lines = [block.columns.map((c) => cell(c.name)), ...block.rows.map((row) => row.map(cell))];
  return lines.map((line) => line.join('\t')).join('\n');
}

const isNumeric = (type: string | undefined) => type === 'integer' || type === 'number';

function format(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return value.toLocaleString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  const na = Number(a);
  const nb = Number(b);
  if (typeof a !== 'object' && typeof b !== 'object' && !Number.isNaN(na) && !Number.isNaN(nb) && a !== '' && b !== '') {
    return na - nb;
  }
  return String(a).localeCompare(String(b));
}
