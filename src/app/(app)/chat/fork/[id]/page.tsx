import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { NotFoundError } from '@/core';
import { forkConversationAction } from '@/web/chat/actions';
import styles from '@/web/chat/chat.module.css';
import { Botley } from '@/web/components/Botley';
import { PendingButton } from '@/web/components/PendingButton';
import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';

export const metadata = { title: 'Open in dashboard · Botley' };

/**
 * Where Slack's "Open in dashboard" link lands. Creating the Fork is a POST (the button), so
 * link previews and prefetching never create Conversations. Non-Participants get 404.
 */
export default async function ForkPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const found = await (await getCore()).conversations.get(user.slackUserId, id).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!found) notFound();
  const { conversation, messages } = found;
  if (conversation.source.kind !== 'slack') redirect(`/chat/${conversation.id}`);
  const prompts = messages.filter((m) => m.kind === 'prompt').length;

  return (
    <div className={`${styles.page} page-narrow`}>
      <header className={styles.hero}>
        <Botley size={96} />
        <h1>Continue in the dashboard</h1>
      </header>
      <section className="card">
        <p>
          <span className="tag">Slack</span> <strong>{conversation.title || 'Slack thread'}</strong> ({prompts}{' '}
          {prompts === 1 ? 'Prompt' : 'Prompts'})
        </p>
        <p>
          A Fork is a new web Conversation that starts with this thread&apos;s history, so Botley keeps the context. Nothing
          you ask in it is posted to Slack, and the thread stays as it is.
        </p>
        <div className="actions">
          <form action={forkConversationAction}>
            <input type="hidden" name="conversationId" value={conversation.id} />
            <PendingButton>Start the Fork</PendingButton>
          </form>
          <Link href={`/chat/${conversation.id}`} className="btn btn--ghost">
            Just view the thread
          </Link>
        </div>
      </section>
    </div>
  );
}
