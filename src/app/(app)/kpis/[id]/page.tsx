import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  approvableAnswer,
  describeCondition,
  describeSchedule,
  formatNumber,
  NotFoundError,
  type AppCore,
  type Kpi,
  type KpiAlert,
  type SlackChannel,
} from '@/core';
import { AnswerView } from '@/web/chat/AnswerView';
import chat from '@/web/chat/chat.module.css';
import { PendingButton } from '@/web/components/PendingButton';
import { requireUser } from '@/web/current-user';
import { deleteAlertAction, deleteKpiAction, pauseOrResumeAlertAction, pauseOrResumeKpiAction } from '@/web/kpis/actions';
import { AlertForm } from '@/web/kpis/AlertForm';
import { ApproveKpiButton } from '@/web/kpis/ApproveKpiButton';
import { RefreshKpiButton } from '@/web/kpis/RefreshKpiButton';
import { RenameKpiForm } from '@/web/kpis/RenameKpiForm';
import { formatInZone } from '@/web/reports/format';
import styles from '@/web/reports/reports.module.css';
import { getCore } from '@/web/server-runtime';
import { CopyButton } from '@/web/components/CopyButton';

export const metadata = { title: 'KPI · BIBot' };
export const dynamic = 'force-dynamic';

/** One KPI: its current value, controls, its KPI Alerts and, while a draft, the Answer to approve. */
export default async function KpiPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const core = await getCore();
  const kpi = await core.kpis.get(user.slackUserId, id).catch(orNull);
  if (!kpi) notFound();
  const alerts = kpi.status === 'draft' ? [] : await core.kpis.listAlerts(user.slackUserId, kpi.id);
  const channels: SlackChannel[] | null = kpi.status === 'draft' ? [] : await core.reports.slackChannels(user.slackUserId).catch(() => null);

  return (
    <div className={chat.page}>
      <header className={chat.conversationHeader}>
        <h1>{kpi.name}</h1>
        <Link href="/kpis" className="btn btn--ghost">
          All KPIs
        </Link>
      </header>

      <div className="actions">
        <RenameKpiForm id={kpi.id} name={kpi.name} />
        {kpi.status !== 'draft' && (
          <form action={pauseOrResumeKpiAction}>
            <input type="hidden" name="id" value={kpi.id} />
            <input type="hidden" name="change" value={kpi.status === 'active' ? 'pause' : 'resume'} />
            <PendingButton className="btn btn--ghost">{kpi.status === 'active' ? 'Pause' : 'Resume'}</PendingButton>
          </form>
        )}
        {user.role === 'admin' && (
          <form action={deleteKpiAction}>
            <input type="hidden" name="id" value={kpi.id} />
            <PendingButton className="btn btn--pink">Delete</PendingButton>
          </form>
        )}
      </div>

      <dl className={`card ${styles.facts}`}>
        <dt>Value</dt>
        <dd>
          {kpi.value ? (
            <>
              <strong className={styles.mono}>{formatNumber(kpi.value.value)}</strong>{' '}
              <span className={chat.muted}>as of {formatInZone(kpi.value.at, 'UTC')} UTC</span>
              <RefreshKpiButton id={kpi.id} />
            </>
          ) : (
            'Not measured until approved'
          )}
        </dd>
        <dt>Status</dt>
        <dd>
          <span className="tag">{kpi.status}</span>
          {kpi.status === 'paused' && <span className={chat.muted}> Its Alerts skip their checks.</span>}
        </dd>
        <dt>Definition</dt>
        <dd className={chat.copyable}>
          <span>“{kpi.prompt}”</span>
        </dd>
        <dt>Created by</dt>
        <dd>
          {kpi.createdByName} on {kpi.createdAt.toISOString().slice(0, 10)}
        </dd>
      </dl>

      {kpi.status === 'draft' ? (
        <ApprovalReview core={core} actor={user.slackUserId} kpi={kpi} />
      ) : (
        <>
          <Alerts alerts={alerts} actor={user.slackUserId} isAdmin={user.role === 'admin'} />
          <details className="card">
            <summary>
              <strong>New KPI Alert</strong>
            </summary>
            <AlertForm kpiId={kpi.id} channels={channels} />
          </details>
        </>
      )}

      {kpi.pinned && (
        <details>
          <summary>Pinned Query</summary>
          <ol className={chat.queries}>
            {kpi.pinned.queries.map((q) => (
              <li key={q.resultId} className={chat.query}>
                <div className={chat.queryHead}>
                  <p className={chat.queryMeta}>
                    <strong>{q.dataSourceName}</strong> · {q.language.toUpperCase()} · {q.resultId}
                  </p>
                  <CopyButton text={q.query} label="Copy query" />
                </div>
                <pre className={chat.queryText}>{q.query}</pre>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

function Alerts({ alerts, actor, isAdmin }: { alerts: KpiAlert[]; actor: string; isAdmin: boolean }) {
  return (
    <section className={styles.fieldset}>
      <h2>KPI Alerts</h2>
      {alerts.length === 0 ? (
        <p className={chat.muted}>No Alerts yet. An Alert posts to Slack once when its condition becomes true.</p>
      ) : (
        <ul className={styles.list}>
          {alerts.map((a) => (
            <li key={a.id} className={`card ${styles.item}`}>
              <span>
                <strong>{a.name}</strong>{' '}
                {a.status === 'paused' ? (
                  <span className="tag">paused</span>
                ) : (
                  <span className={a.state === 'fired' ? `tag ${styles.failedTag}` : 'tag'}>{a.state === 'fired' ? 'firing' : 'armed'}</span>
                )}
              </span>
              <span className={chat.muted}>
                When {describeCondition(a.condition)} · {describeSchedule(a.schedule)} ({a.timezone}) ·{' '}
                {a.destination.kind === 'dm' ? (a.destination.slackUserId === actor ? 'DM to you' : `DM to ${a.createdByName}`) : 'channel'}
                {a.nextCheckAt && <> · next check {formatInZone(a.nextCheckAt, a.timezone)}</>}
              </span>
              {a.lastError && <span className={chat.muted}>Last check failed: {a.lastError}</span>}
              <span className="actions">
                <Link href={`/kpis/alerts/${a.id}/edit`} className="btn btn--ghost">
                  Edit
                </Link>
                <form action={pauseOrResumeAlertAction}>
                  <input type="hidden" name="id" value={a.id} />
                  <input type="hidden" name="change" value={a.status === 'active' ? 'pause' : 'resume'} />
                  <PendingButton className="btn btn--ghost">{a.status === 'active' ? 'Pause' : 'Resume'}</PendingButton>
                </form>
                {isAdmin && (
                  <form action={deleteAlertAction}>
                    <input type="hidden" name="id" value={a.id} />
                    <input type="hidden" name="kpiId" value={a.kpiId} />
                    <PendingButton className="btn btn--pink">Delete</PendingButton>
                  </form>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The agent's Answer to check before approving a draft KPI. */
async function ApprovalReview({ core, actor, kpi }: { core: AppCore; actor: string; kpi: Kpi }) {
  const conversation = await core.conversations.get(actor, kpi.conversationId).catch(orNull);
  if (!conversation) return <p className={chat.notice}>Only {kpi.createdByName} can see this KPI&apos;s Answer and approve it.</p>;
  const approvable = approvableAnswer(conversation.messages);
  return (
    <section className={styles.fieldset}>
      <h2>Check and approve</h2>
      <p className={chat.muted}>
        A KPI is one number: the first number in the single row of this Answer&apos;s result. Approving pins its query; Alert checks
        re-run it without asking BIBot again. Not quite right? <Link href={`/chat/${conversation.conversation.id}`}>Refine it in chat</Link>,
        then come back and approve.
      </p>
      {approvable ? (
        <>
          <AnswerView blocks={approvable.answer.blocks} sources={approvable.answer.sources} queries={approvable.answer.queries} />
          <ApproveKpiButton id={kpi.id} />
        </>
      ) : (
        <p className={chat.notice}>There is no complete Answer to approve yet. Refine it in chat first.</p>
      )}
    </section>
  );
}

function orNull(error: unknown): null {
  if (error instanceof NotFoundError) return null;
  throw error;
}
