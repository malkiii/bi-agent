import Link from 'next/link';
import type { SavedQuestion } from '@/core';
import { Botley } from '@/web/components/Botley';
import chat from '@/web/chat/chat.module.css';
import { requireUser } from '@/web/current-user';
import styles from '@/web/saved-questions/questions.module.css';
import { getCore } from '@/web/server-runtime';

export const metadata = { title: 'Saved Questions · Botley' };

/** The person's own Saved Questions and everyone's shared ones. */
export default async function SavedQuestionsPage() {
  const user = await requireUser();
  const core = await getCore();
  const [mine, shared] = await Promise.all([
    core.savedQuestions.list(user.slackUserId, { scope: 'mine' }),
    core.savedQuestions.list(user.slackUserId, { scope: 'shared' }),
  ]);
  return (
    <div className={chat.page}>
      <h1>Saved Questions</h1>
      <section>
        <h2>Mine</h2>
        {mine.length === 0 ? (
          <div className={chat.hero}>
            <Botley rest="empty" size={72} />
            <p className={chat.muted}>
              None yet. Use “Save question” under an Answer in <Link href="/chat">Chat</Link>.
            </p>
          </div>
        ) : (
          <QuestionList questions={mine} showOwner={false} />
        )}
      </section>
      <section>
        <h2>Shared with everyone</h2>
        {shared.length === 0 ? (
          <p className={chat.muted}>Nobody has shared a Saved Question yet.</p>
        ) : (
          <QuestionList questions={shared} showOwner />
        )}
      </section>
    </div>
  );
}

function QuestionList({ questions, showOwner }: { questions: SavedQuestion[]; showOwner: boolean }) {
  return (
    <ul className={styles.list}>
      {questions.map((q) => (
        <li key={q.id}>
          <Link href={`/questions/${q.id}`}>{q.title}</Link> <span className="tag">{q.visibility}</span>
          {showOwner && <span className={chat.muted}> by {q.ownerName}</span>}
        </li>
      ))}
    </ul>
  );
}
