import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError } from '@/core';
import chat from '@/web/chat/chat.module.css';
import { requireUser } from '@/web/current-user';
import { PendingButton } from '@/web/components/PendingButton';
import { deleteSavedQuestionAction, setVisibilityAction } from '@/web/saved-questions/actions';
import { RunView } from '@/web/saved-questions/RunView';
import styles from '@/web/saved-questions/questions.module.css';
import { getCore } from '@/web/server-runtime';

export const metadata = { title: 'Saved Question · Botley' };

/** One Saved Question: its Prompt, Pinned Queries, owner controls and a one-click re-run. */
export default async function SavedQuestionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const question = await (await getCore()).savedQuestions.get(user.slackUserId, id).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!question) notFound();
  const isOwner = question.ownerSlackUserId === user.slackUserId;
  return (
    <div className={chat.page}>
      <header className={chat.conversationHeader}>
        <h1>{question.title}</h1>
        <Link href="/questions" className="btn btn--ghost">
          All Saved Questions
        </Link>
      </header>
      <p>
        <span className="tag">{question.visibility}</span>{' '}
        <span className={chat.muted}>
          Saved by {isOwner ? 'you' : question.ownerName} on {question.createdAt.toISOString().slice(0, 10)}
        </span>
      </p>
      {question.prompt && <p className={styles.prompt}>“{question.prompt}”</p>}
      {(isOwner || user.role === 'admin') && (
        <div className="actions">
          {isOwner && (
            <form action={setVisibilityAction}>
              <input type="hidden" name="id" value={question.id} />
              <input type="hidden" name="visibility" value={question.visibility === 'shared' ? 'private' : 'shared'} />
              <PendingButton className="btn btn--ghost">
                {question.visibility === 'shared' ? 'Make private' : 'Share with everyone'}
              </PendingButton>
            </form>
          )}
          <form action={deleteSavedQuestionAction}>
            <input type="hidden" name="id" value={question.id} />
            <PendingButton className="btn btn--ghost">Delete</PendingButton>
          </form>
        </div>
      )}
      <RunView id={question.id} />
      <details>
        <summary>Pinned Queries ({question.pinned.queries.length})</summary>
        <ol className={chat.queries}>
          {question.pinned.queries.map((q) => (
            <li key={q.resultId} className={chat.query}>
              <p className={chat.queryMeta}>
                <strong>{q.dataSourceName}</strong> · {q.language.toUpperCase()} · {q.resultId}
              </p>
              <pre className={chat.queryText}>{q.query}</pre>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
