import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError } from '@/core';
import { forkConversationAction } from '@/web/chat/actions';
import { ChatView } from '@/web/chat/ChatView';
import styles from '@/web/chat/chat.module.css';
import { chatDataSources } from '@/web/chat/data-sources';
import { toChatItems } from '@/web/chat/items';
import { PendingButton } from '@/web/components/PendingButton';
import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';

export const metadata = { title: 'Chat · BIBot' };

/**
 * A saved Conversation, reopened. Only its Participants can see it. Web Conversations
 * continue here; Slack ones are shown read-only with "Open in dashboard" (a Fork).
 */
export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const core = await getCore();
  const found = await core.conversations.get(user.slackUserId, id).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!found) notFound();
  const { conversation, messages } = found;
  const slack = conversation.source.kind === 'slack';
  return (
    <div className={styles.page}>
      <header className={styles.conversationHeader}>
        <h1>{conversation.title || 'New Conversation'}</h1>
        <div className={`actions ${styles.headerActions}`}>
          {slack && (
            <form action={forkConversationAction}>
              <input type="hidden" name="conversationId" value={conversation.id} />
              <PendingButton className="btn btn--cyan">Open in dashboard</PendingButton>
            </form>
          )}
          <Link href="/chat" className="btn btn--ghost">
            New chat
          </Link>
        </div>
      </header>
      {slack && (
        <p className={styles.notice}>
          <span className="tag">Slack</span> This Conversation happened in a Slack thread. Open it in the dashboard to ask
          follow-ups here in a Fork; the thread stays as it is.
        </p>
      )}
      {conversation.forkedFrom && (
        <p className={styles.notice}>
          <span className="tag">Fork</span> Started from a{' '}
          <Link href={`/chat/${conversation.forkedFrom.conversationId}`}>Slack thread</Link>. Nothing you ask here is posted to
          Slack.
        </p>
      )}
      <ChatView
        key={conversation.id}
        conversationId={conversation.id}
        initialItems={toChatItems(messages)}
        readOnly={slack}
        dataSources={slack ? [] : await chatDataSources(core, conversation.lockedDataSourceIds)}
        lockedDataSourceIds={conversation.lockedDataSourceIds}
      />
    </div>
  );
}
