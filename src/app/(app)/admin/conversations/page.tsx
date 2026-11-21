import Link from 'next/link';
import { Botley } from '@/web/components/Botley';
import { PendingButton } from '@/web/components/PendingButton';
import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';
import styles from '../audit/audit.module.css';
import { deleteConversationAction } from './actions';

export const metadata = { title: 'Conversations · Botley' };
export const dynamic = 'force-dynamic';

const NOTICES: Record<string, string> = {
  deleted: 'Conversation deleted.',
  gone: 'That Conversation was already deleted.',
};
const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

function href(page: number) {
  return page > 1 ? `/admin/conversations?page=${page}` : '/admin/conversations';
}

/**
 * Admin: every Conversation, whoever took part, to delete ones that should not be kept. Their
 * content stays private: only Participants can open them. Access: src/proxy.ts plus the App Core.
 */
export default async function ConversationsAdminPage({ searchParams }: { searchParams: Promise<{ page?: string; notice?: string; error?: string }> }) {
  const params = await searchParams;
  const me = await requireUser();
  const core = await getCore();
  const [{ conversations, page, hasNextPage }, users] = await Promise.all([
    core.conversations.listAll(me.slackUserId, { page: Number(params.page) || 1 }),
    core.users.list(me.slackUserId),
  ]);
  const names = new Map(users.map((u) => [u.slackUserId, u.name]));
  const notice = params.notice ? NOTICES[params.notice] : undefined;

  return (
    <section className={`card ${styles.page}`}>
      <h1>Conversations</h1>
      <p className={styles.muted}>
        Every Conversation with at least one Prompt, newest first. Deleting one removes its Prompts and Answers for everyone. A
        Conversation a Report or draft KPI was made from can be deleted once they are. Times are UTC.
      </p>
      {notice && <p role="status">{notice}</p>}
      {params.error && (
        <p role="alert" className={styles.error}>
          {params.error}
        </p>
      )}

      {conversations.length === 0 ? (
        <div className={styles.empty}>
          <Botley rest="empty" size={80} />
          <p>{page > 1 ? 'No more Conversations.' : 'No Conversations yet.'}</p>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Title</th>
                <th>Source</th>
                <th>Participants</th>
                <th>Last activity</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {conversations.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.participants.includes(me.slackUserId) ? <Link href={`/chat/${c.id}`}>{c.title || 'Untitled'}</Link> : c.title || 'Untitled'}
                  </td>
                  <td>
                    <span className="tag">{c.forkedFrom ? 'fork' : c.source.kind}</span>
                  </td>
                  <td>{c.participants.map((p) => names.get(p) ?? p).join(', ')}</td>
                  <td className={styles.nowrap}>
                    <time dateTime={c.updatedAt.toISOString()}>{dateFormat.format(c.updatedAt)}</time>
                  </td>
                  <td>
                    <form action={deleteConversationAction}>
                      <input type="hidden" name="id" value={c.id} />
                      <input type="hidden" name="back" value={href(page)} />
                      <PendingButton className="btn btn--pink">Delete</PendingButton>
                    </form>
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
            <Link href={href(page - 1)} className="btn btn--ghost" rel="prev">
              ← Newer
            </Link>
          ) : (
            <span />
          )}
          <span>Page {page}</span>
          {hasNextPage ? (
            <Link href={href(page + 1)} className="btn btn--ghost" rel="next">
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
