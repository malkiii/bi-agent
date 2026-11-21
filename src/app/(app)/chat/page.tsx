import Link from 'next/link';
import { Botley } from '@/web/components/Botley';
import { ChatView } from '@/web/chat/ChatView';
import styles from '@/web/chat/chat.module.css';
import { chatDataSources } from '@/web/chat/data-sources';
import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';

export const metadata = { title: 'Chat · Botley' };

/** New web chat: a big prompt box, with the person's recent Conversations below. */
export default async function NewChatPage() {
  const user = await requireUser();
  const core = await getCore();
  const [recent, dataSources] = await Promise.all([
    core.conversations.list(user.slackUserId, { limit: 20 }),
    chatDataSources(core),
  ]);
  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <Botley size={96} />
        <h1>What do you want to know?</h1>
      </header>
      <ChatView initialItems={[]} dataSources={dataSources} />
      <section className={styles.recent}>
        <h2>
          Recent Conversations{' '}
          <Link href="/history" className={styles.seeAll}>
            See all
          </Link>
        </h2>
        {recent.length === 0 ? (
          <p className={styles.muted}>None yet. Your Conversations will show up here.</p>
        ) : (
          <ul>
            {recent.map((c) => (
              <li key={c.id}>
                <Link href={`/chat/${c.id}`}>{c.title || 'Untitled'}</Link>{' '}
                <span className="tag">{c.source.kind}</span>{' '}
                <time className={styles.muted} dateTime={c.updatedAt.toISOString()}>
                  {c.updatedAt.toISOString().slice(0, 16).replace('T', ' ')}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
