import Link from 'next/link';
import { notFound } from 'next/navigation';
import { approvableAnswer, describeSchedule, NotFoundError, type AppCore, type Report } from '@/core';
import { AnswerView } from '@/web/chat/AnswerView';
import chat from '@/web/chat/chat.module.css';
import { requireUser } from '@/web/current-user';
import { ApproveButton } from '@/web/reports/ApproveButton';
import { formatInZone } from '@/web/reports/format';
import styles from '@/web/reports/reports.module.css';
import { RunView } from '@/web/saved-questions/RunView';
import { getCore } from '@/web/server-runtime';

export const metadata = { title: 'Report · Botley' };
export const dynamic = 'force-dynamic';

/** One Report: its settings and, while a draft, the Answer to approve. */
export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const core = await getCore();
  const report = await core.reports.get(user.slackUserId, id).catch(orNull);
  if (!report) notFound();
  const destination = await destinationLabel(core, user.slackUserId, report);

  return (
    <div className={chat.page}>
      <header className={chat.conversationHeader}>
        <h1>{report.title}</h1>
        <Link href="/reports" className="btn btn--ghost">
          All Reports
        </Link>
      </header>
      <dl className={`card ${styles.facts}`}>
        <dt>Status</dt>
        <dd>
          <span className="tag">{report.status}</span>
        </dd>
        <dt>Prompt</dt>
        <dd>“{report.prompt}”</dd>
        <dt>Schedule</dt>
        <dd>
          {describeSchedule(report.schedule)} ({report.timezone})
        </dd>
        <dt>Next run</dt>
        <dd>{report.nextRunAt ? formatInZone(report.nextRunAt, report.timezone) : 'Not scheduled until approved'}</dd>
        <dt>Sends to</dt>
        <dd>{destination}</dd>
        <dt>Created by</dt>
        <dd>
          {report.createdByName} on {report.createdAt.toISOString().slice(0, 10)}
        </dd>
        {report.approvedAt && (
          <>
            <dt>Approved</dt>
            <dd>{formatInZone(report.approvedAt, report.timezone)}</dd>
          </>
        )}
      </dl>

      {report.status === 'draft' && <DraftReview core={core} actor={user.slackUserId} report={report} />}

      {report.pinned && (
        <details>
          <summary>Pinned Queries ({report.pinned.queries.length})</summary>
          <ol className={chat.queries}>
            {report.pinned.queries.map((q) => (
              <li key={q.resultId} className={chat.query}>
                <p className={chat.queryMeta}>
                  <strong>{q.dataSourceName}</strong> · {q.language.toUpperCase()} · {q.resultId}
                </p>
                <pre className={chat.queryText}>{q.query}</pre>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

/** The draft's Answer (from its Conversation or Saved Question) with the approve button. */
async function DraftReview({ core, actor, report }: { core: AppCore; actor: string; report: Report }) {
  if (report.origin.kind === 'savedQuestion') {
    const question = await core.savedQuestions.get(actor, report.origin.savedQuestionId).catch(orNull);
    if (!question) return <p className={chat.notice}>This draft uses a Saved Question you can&apos;t see, so only its owner can approve it.</p>;
    return (
      <section className={styles.fieldset}>
        <h2>Check and approve</h2>
        <p className={chat.muted}>
          Its queries come from the Saved Question <Link href={`/questions/${question.id}`}>{question.title}</Link>. Run it to see
          today&apos;s results, then approve to pin them and start the schedule.
        </p>
        <RunView id={question.id} />
        <ApproveButton id={report.id} />
      </section>
    );
  }

  const conversation = await core.conversations.get(actor, report.origin.conversationId).catch(orNull);
  if (!conversation) return <p className={chat.notice}>Only {report.createdByName} can see this draft&apos;s Answer and approve it.</p>;
  const approvable = approvableAnswer(conversation.messages);
  const newest = conversation.messages.findLast((m) => m.kind === 'answer');
  return (
    <section className={styles.fieldset}>
      <h2>Check and approve</h2>
      <p className={chat.muted}>
        Approving pins the queries and layout of this Answer; each run re-executes them and Botley adds fresh commentary. Not
        quite right? <Link href={`/chat/${conversation.conversation.id}`}>Refine it in chat</Link>, then come back and approve.
      </p>
      {newest && newest !== approvable && (
        <p className={chat.notice}>
          The latest Answer failed, so approving uses the last complete one, shown below.
        </p>
      )}
      {approvable ? (
        <>
          <AnswerView blocks={approvable.answer.blocks} sources={approvable.answer.sources} queries={approvable.answer.queries} />
          <ApproveButton id={report.id} />
        </>
      ) : (
        <p className={chat.notice}>There is no complete Answer to approve yet. Refine the Prompt in chat first.</p>
      )}
    </section>
  );
}

async function destinationLabel(core: AppCore, actor: string, report: Report): Promise<string> {
  if (report.destination.kind === 'dm') {
    return report.destination.slackUserId === actor ? 'You, in a DM' : `${report.createdByName}, in a DM`;
  }
  const { channel } = report.destination;
  const channels = await core.reports.slackChannels(actor).catch(() => []);
  const name = channels.find((c) => c.id === channel)?.name;
  return name ? `#${name}` : channel;
}

function orNull(error: unknown): null {
  if (error instanceof NotFoundError) return null;
  throw error;
}
