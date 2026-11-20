import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError } from '@/core';
import { ChatView } from '@/web/chat/ChatView';
import styles from '@/web/chat/chat.module.css';
import { toChatItems } from '@/web/chat/items';
import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';

export const metadata = { title: 'Chat · Botley' };

/** A saved Conversation, reopened. Only its Participants can see it. */
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
  return (
    <div className={styles.page}>
      <header className={styles.conversationHeader}>
        <h1>{conversation.title || 'New Conversation'}</h1>
        <Link href="/chat" className="btn btn--ghost">
          New chat
        </Link>
      </header>
      <ChatView key={conversation.id} conversationId={conversation.id} initialItems={toChatItems(messages)} />
    </div>
  );
}
