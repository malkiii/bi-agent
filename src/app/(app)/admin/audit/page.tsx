import Link from 'next/link';
import { BIBot } from '@/web/components/BIBot';
import { AUDIT_EVENT_TYPES, BIBOT_ACTOR, type AuditEntry, type AuditEventType, type AuditFilter } from '@/core';
import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';
import styles from './audit.module.css';
import { CopyButton } from '@/web/components/CopyButton';

export const metadata = { title: 'Audit log · BIBot' };
export const dynamic = 'force-dynamic';

const TYPE_LABELS: Record<AuditEventType, string> = {
  prompt: 'Prompt',
  query: 'Query',
  tokens: 'Token usage',
  data_source: 'Data Source',
  dataset: 'Dataset',
  channel_default: 'Channel Default',
  role: 'Role',
  llm_settings: 'LLM settings',
  report: 'Report',
  report_run: 'Report Run',
  kpi: 'KPI',
  kpi_alert: 'KPI Alert',
  conversation: 'Conversation',
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' });

type Params = { actor?: string; type?: string; from?: string; to?: string; page?: string };

/** The filter from the query string; malformed values are ignored. `to` includes that whole day. */
function filterFrom(params: Params): AuditFilter & { fromDay?: string; toDay?: string } {
  const type = AUDIT_EVENT_TYPES.find((t) => t === params.type);
  const fromDay = params.from && DAY.test(params.from) ? params.from : undefined;
  const toDay = params.to && DAY.test(params.to) ? params.to : undefined;
  return {
    actor: params.actor || undefined,
    type,
    fromDay,
    toDay,
    from: fromDay ? new Date(`${fromDay}T00:00:00Z`) : undefined,
    to: toDay ? new Date(new Date(`${toDay}T00:00:00Z`).getTime() + 86_400_000) : undefined,
    page: Number(params.page) || 1,
  };
}

function pageHref(params: Params, page: number): string {
  const query = new URLSearchParams(Object.entries({ ...params, page: String(page) }).filter(([, v]) => v) as [string, string][]);
  return `/admin/audit?${query}`;
}

/** Admin: the audit log, newest first. Access: src/proxy.ts plus `audit.list` in the App Core. */
export default async function AuditPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const me = await requireUser();
  const core = await getCore();
  const filter = filterFrom(params);
  const [{ entries, page, hasNextPage }, users] = await Promise.all([
    core.audit.list(me.slackUserId, filter),
    core.users.list(me.slackUserId),
  ]);
  const names = new Map<string, string>([[BIBOT_ACTOR, 'BIBot (scheduled)'], ...users.map((u) => [u.slackUserId, u.name] as const)]);

  return (
    <section className={`card ${styles.page}`}>
      <h1>Audit log</h1>
      <p className={styles.muted}>
        Prompts, the queries they ran, token usage, and every change to configuration and scheduled work. Times are UTC.
      </p>

      <form className={styles.filters} method="get" action="/admin/audit">
        <label>
          Who
          <select name="actor" defaultValue={filter.actor ?? ''}>
            <option value="">Anyone</option>
            <option value={BIBOT_ACTOR}>BIBot (scheduled)</option>
            {users.map((u) => (
              <option key={u.slackUserId} value={u.slackUserId}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Type
          <select name="type" defaultValue={filter.type ?? ''}>
            <option value="">All types</option>
            {AUDIT_EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input type="date" name="from" defaultValue={filter.fromDay ?? ''} />
        </label>
        <label>
          To
          <input type="date" name="to" defaultValue={filter.toDay ?? ''} />
        </label>
        <div className="actions">
          <button type="submit" className="btn">
            Filter
          </button>
          <Link href="/admin/audit" className="btn btn--ghost">
            Clear
          </Link>
        </div>
      </form>

      {entries.length === 0 ? (
        <div className={styles.empty}>
          <BIBot rest="empty" size={80} />
          <p>{page > 1 ? 'No more entries.' : 'No entries match.'}</p>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className={styles.nowrap}>
                    <time dateTime={e.at.toISOString()}>{dateFormat.format(e.at)}</time>
                  </td>
                  <td>{names.get(e.actor) ?? e.actor}</td>
                  <td>
                    <span className="tag">{TYPE_LABELS[e.type] ?? e.type}</span> {e.action.replaceAll('_', ' ')}
                    {e.target && <div className={styles.muted}>{e.target.name || e.target.id}</div>}
                  </td>
                  <td>
                    <EntryDetails entry={e} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(page > 1 || hasNextPage) && (
        <nav className={styles.pager} aria-label="Pages">
          {page > 1 ? (
            <Link href={pageHref(params, page - 1)} className="btn btn--ghost" rel="prev">
              ← Newer
            </Link>
          ) : (
            <span />
          )}
          <span>Page {page}</span>
          {hasNextPage ? (
            <Link href={pageHref(params, page + 1)} className="btn btn--ghost" rel="next">
              Older →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </section>
  );
}

/** A readable summary for usage entries; the raw details for everything else. */
function EntryDetails({ entry }: { entry: AuditEntry }) {
  const d = entry.details;
  if (entry.type === 'prompt') {
    const prompt = String(d.prompt ?? '');
    return (
      <div className={styles.copyable}>
        <span>“{prompt}”</span>
        <CopyButton text={prompt} label="Copy prompt" />
      </div>
    );
  }
  if (entry.type === 'query') {
    return (
      <div>
        <div>
          {String(d.dataSourceName)} · {d.ok ? `${d.rowCount} rows` : 'failed'} · {String(d.durationMs)} ms
        </div>
        <div className={styles.copyable}>
          <code className={styles.query}>{String(d.query ?? '')}</code>
          <CopyButton text={String(d.query ?? '')} label="Copy query" />
        </div>
        {typeof d.error === 'string' && <div className={styles.muted}>{d.error}</div>}
      </div>
    );
  }
  if (entry.type === 'tokens') {
    return (
      <span>
        {String(d.inputTokens)} in / {String(d.outputTokens)} out · {String(d.provider ?? '?')}/{String(d.model ?? '?')} ·{' '}
        {String(d.purpose).replaceAll('_', ' ')}
      </span>
    );
  }
  if (Object.keys(d).length === 0) return null;
  return <code className={styles.query}>{JSON.stringify(d)}</code>;
}
