import Link from 'next/link';
import type { ConversationSource } from '@/core';
import { DeleteConversationButton } from '@/web/chat/DeleteConversationButton';
import { BIBot } from '@/web/components/BIBot';
import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';
import styles from './history.module.css';

export const metadata = { title: 'History · BIBot' };

const NOTICES: Record<string, string> = {
  deleted: 'Chat deleted.',
  gone: 'That chat was already deleted.',
};

const FILTERS: { label: string; source?: ConversationSource['kind'] }[] = [
  { label: 'All' },
  { label: 'Web', source: 'web' },
  { label: 'Slack', source: 'slack' },
];

function href(source: ConversationSource['kind'] | undefined, page = 1) {
  const params = new URLSearchParams();
  if (source) params.set('source', source);
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return query ? `/history?${query}` : '/history';
}

/** The Conversations the signed-in person took part in, newest first, filterable by Source. Any Participant can delete one. */
export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; page?: string; notice?: string; error?: string }>;
}) {
  const params = await searchParams;
  const source = params.source === 'web' || params.source === 'slack' ? params.source : undefined;
  const user = await requireUser();
  const { conversations, page, hasNextPage } = await (await getCore()).conversations.history(user.slackUserId, {
    source,
    page: Number(params.page) || 1,
  });
  const notice = params.notice ? NOTICES[params.notice] : undefined;
  const here = href(source, page);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>History</h1>
        <nav className={styles.filters} aria-label="Filter by Source">
          {FILTERS.map((f) => (
            <Link
              key={f.label}
              href={href(f.source)}
              className={`btn ${f.source === source ? '' : 'btn--ghost'}`}
              aria-current={f.source === source ? 'page' : undefined}
            >
              {f.label}
            </Link>
          ))}
        </nav>
      </header>

      {notice && <p role="status">{notice}</p>}
      {params.error && (
        <p role="alert" className={styles.error}>
          {params.error}
        </p>
      )}

      {conversations.length === 0 ? (
        <section className={`card ${styles.empty}`}>
          <BIBot rest="empty" size={80} />
          <p>
            {page > 1 ? 'No more Conversations.' : 'No Conversations yet.'} <Link href="/chat">Ask BIBot something</Link> or
            @mention it in Slack.
          </p>
        </section>
      ) : (
        <ul className={styles.list}>
          {conversations.map((c) => (
            <li key={c.id} className={`card ${styles.item}`}>
              <div className={styles.itemMain}>
                <Link href={`/chat/${c.id}`} className={styles.title}>
                  {c.title || 'Untitled'}
                </Link>
                <p className={styles.meta}>
                  <span className="tag">{c.forkedFrom ? 'fork' : c.source.kind}</span>{' '}
                  <time dateTime={c.updatedAt.toISOString()}>{c.updatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC</time>
                  {c.participants.length > 1 && ` · ${c.participants.length} Participants`}
                </p>
              </div>
              <div className={styles.itemActions}>
                <DeleteConversationButton conversationId={c.id} back={here} className="btn btn--ghost" />
              </div>
            </li>
          ))}
        </ul>
      )}

      {(page > 1 || hasNextPage) && (
        <nav className={styles.pager} aria-label="Pages">
          {page > 1 ? (
            <Link href={href(source, page - 1)} className="btn btn--ghost" rel="prev">
              ← Newer
            </Link>
          ) : (
            <span />
          )}
          <span className={styles.pageNumber}>Page {page}</span>
          {hasNextPage ? (
            <Link href={href(source, page + 1)} className="btn btn--ghost" rel="next">
              Older →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
}
