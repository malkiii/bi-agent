import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  approvableAnswer,
  describeSchedule,
  NotFoundError,
  reportPath,
  reportRunPath,
  type AppCore,
  type Report,
  type ReportRunSummary,
} from '@/core';
import { AnswerView } from '@/web/chat/AnswerView';
import chat from '@/web/chat/chat.module.css';
import { PendingButton } from '@/web/components/PendingButton';
import { requireUser } from '@/web/current-user';
import { deleteReportAction, deleteReportRunAction, pauseOrResumeReportAction } from '@/web/reports/actions';
import { ApproveButton } from '@/web/reports/ApproveButton';
import { formatInZone, statusLabel } from '@/web/reports/format';
import styles from '@/web/reports/reports.module.css';
import { RunView } from '@/web/saved-questions/RunView';
import { getCore } from '@/web/server-runtime';

export const metadata = { title: 'Report · Botley' };
export const dynamic = 'force-dynamic';

/** One Report: its settings, controls, past Report Runs and, while a draft or after a failure, the Answer to approve. */
export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const core = await getCore();
  const report = await core.reports.get(user.slackUserId, id).catch(orNull);
  if (!report) notFound();
  const [destination, runs] = await Promise.all([
    destinationLabel(core, user.slackUserId, report),
    core.reports.listRuns(user.slackUserId, report.id),
  ]);

  return (
    <div className={chat.page}>
      <header className={chat.conversationHeader}>
        <h1>{report.title}</h1>
        <Link href="/reports" className="btn btn--ghost">
          All Reports
        </Link>
      </header>

      <div className="actions">
        <Link href={`${reportPath(report.id)}/edit`} className="btn btn--ghost">
          Edit
        </Link>
        {(report.status === 'active' || report.status === 'paused') && (
          <form action={pauseOrResumeReportAction}>
            <input type="hidden" name="id" value={report.id} />
            <input type="hidden" name="change" value={report.status === 'active' ? 'pause' : 'resume'} />
            <PendingButton className="btn btn--ghost">{report.status === 'active' ? 'Pause' : 'Resume'}</PendingButton>
          </form>
        )}
        {user.role === 'admin' && (
          <form action={deleteReportAction}>
            <input type="hidden" name="id" value={report.id} />
            <PendingButton className="btn btn--pink">Delete</PendingButton>
          </form>
        )}
      </div>

      {report.status === 'needsReapproval' && report.failure && (
        <p className={styles.error} role="alert">
          The <Link href={reportRunPath(report.failure.runId)}>Report Run</Link> of {formatInZone(report.failure.at, report.timezone)}{' '}
          failed, so this Report is stopped: {report.failure.error}
        </p>
      )}

      <dl className={`card ${styles.facts}`}>
        <dt>Status</dt>
        <dd>
          <span className="tag">{statusLabel(report.status)}</span>
        </dd>
        <dt>Prompt</dt>
        <dd>“{report.prompt}”</dd>
        <dt>Schedule</dt>
        <dd>
          {describeSchedule(report.schedule)} ({report.timezone})
        </dd>
        <dt>Next run</dt>
        <dd>{nextRunLabel(report)}</dd>
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

      {(report.status === 'draft' || report.status === 'needsReapproval') && (
        <ApprovalReview core={core} actor={user.slackUserId} report={report} />
      )}

      <PastRuns runs={runs} reportId={report.id} canDelete={user.role === 'admin'} />

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

function nextRunLabel(report: Report): string {
  if (report.nextRunAt) return formatInZone(report.nextRunAt, report.timezone);
  switch (report.status) {
    case 'draft':
      return 'Not scheduled until approved';
    case 'paused':
      return 'Paused';
    case 'needsReapproval':
      return 'Stopped until its queries are re-approved';
    default:
      return '—';
  }
}

function PastRuns({ runs, reportId, canDelete }: { runs: ReportRunSummary[]; reportId: string; canDelete: boolean }) {
  return (
    <section className={styles.fieldset}>
      <h2>Past Report Runs</h2>
      {runs.length === 0 ? (
        <p className={chat.muted}>No Report Runs yet.</p>
      ) : (
        <ul className={styles.list}>
          {runs.map((run) => (
            <li key={run.id} className={`card ${styles.item}`}>
              <span>
                <Link href={reportRunPath(run.id)}>
                  <strong>{formatInZone(run.scheduledFor, run.timezone)}</strong>
                </Link>{' '}
                <span className={run.status === 'failed' ? `tag ${styles.failedTag}` : 'tag'}>{run.status}</span>
              </span>
              {run.error && <span className={chat.muted}>{run.error}</span>}
              {run.deliveryError && <span className={chat.muted}>Not posted to Slack: {run.deliveryError}</span>}
              {canDelete && (
                <form action={deleteReportRunAction}>
                  <input type="hidden" name="id" value={run.id} />
                  <input type="hidden" name="reportId" value={reportId} />
                  <input type="hidden" name="back" value="report" />
                  <PendingButton className="btn btn--ghost">Delete</PendingButton>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The Answer to approve (from the Conversation or Saved Question), for a draft or a Report that needs re-approval. */
async function ApprovalReview({ core, actor, report }: { core: AppCore; actor: string; report: Report }) {
  const reapproving = report.status === 'needsReapproval';
  const heading = reapproving ? 'Fix and re-approve' : 'Check and approve';
  if (report.origin.kind === 'savedQuestion') {
    const question = await core.savedQuestions.get(actor, report.origin.savedQuestionId).catch(orNull);
    if (!question)
      return <p className={chat.notice}>This Report uses a Saved Question you can&apos;t see, so only its owner can approve it.</p>;
    return (
      <section className={styles.fieldset}>
        <h2>{heading}</h2>
        <p className={chat.muted}>
          Its queries come from the Saved Question <Link href={`/questions/${question.id}`}>{question.title}</Link>. Run it to see
          today&apos;s results, then approve to pin them and {reapproving ? 'resume' : 'start'} the schedule.
        </p>
        <RunView id={question.id} />
        <ApproveButton id={report.id} reapprove={reapproving} />
      </section>
    );
  }

  const conversation = await core.conversations.get(actor, report.origin.conversationId).catch(orNull);
  if (!conversation) return <p className={chat.notice}>Only {report.createdByName} can see this Report&apos;s Answer and approve it.</p>;
  const approvable = approvableAnswer(conversation.messages);
  const newest = conversation.messages.findLast((m) => m.kind === 'answer');
  return (
    <section className={styles.fieldset}>
      <h2>{heading}</h2>
      <p className={chat.muted}>
        {reapproving
          ? 'If a query broke (say, a renamed table), ask Botley to fix it in chat; once the Data Source is right again, re-approve to pin the latest Answer and resume. '
          : 'Approving pins the queries and layout of this Answer; each run re-executes them and Botley adds fresh commentary. Not quite right? '}
        <Link href={`/chat/${conversation.conversation.id}`}>{reapproving ? 'Fix it in chat' : 'Refine it in chat'}</Link>, then come back
        and approve.
      </p>
      {newest && newest !== approvable && (
        <p className={chat.notice}>The latest Answer failed, so approving uses the last complete one, shown below.</p>
      )}
      {approvable ? (
        <>
          <AnswerView blocks={approvable.answer.blocks} sources={approvable.answer.sources} queries={approvable.answer.queries} />
          <ApproveButton id={report.id} reapprove={reapproving} />
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
