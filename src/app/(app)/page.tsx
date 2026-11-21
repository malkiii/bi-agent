import Link from 'next/link';
import { describeCondition, describeSchedule, formatNumber, kpiPath, reportPath } from '@/core';
import { BIBotCue } from '@/web/bibot/BIBotProvider';
import { BIBot } from '@/web/components/BIBot';
import { ChatView } from '@/web/chat/ChatView';
import { chatDataSources } from '@/web/chat/data-sources';
import { requireUser } from '@/web/current-user';
import { formatInZone } from '@/web/reports/format';
import { getCore } from '@/web/server-runtime';
import styles from './home.module.css';

export const dynamic = 'force-dynamic';

/** BIBot celebrates if the user arrived here straight from signing in. */
const JUST_SIGNED_IN_MS = 15_000;

function signedInWithin(lastSignInAt: Date, ms: number, now: Date) {
  return now.getTime() - lastSignInAt.getTime() < ms;
}

/**
 * The dashboard home: a Prompt box that starts a web Conversation, the KPIs' current values,
 * KPI Alerts currently firing, upcoming Report Runs and the person's recent Conversations.
 */
export default async function HomePage() {
  const user = await requireUser();
  const core = await getCore();
  const [home, dataSources] = await Promise.all([core.home.overview(user.slackUserId), chatDataSources(core)]);
  const firstName = user.name.split(' ')[0];

  return (
    <div className={styles.page}>
      {signedInWithin(user.lastSignInAt, JUST_SIGNED_IN_MS, new Date()) && <BIBotCue state="success" />}
      <header className={styles.hero}>
        <BIBot size={72} />
        <div>
          <h1 className={styles.title}>Hi {firstName}, what do you want to know?</h1>
          <p className={styles.lead}>Ask about your data here, or mention BIBot in Slack.</p>
        </div>
      </header>

      <ChatView initialItems={[]} dataSources={dataSources} openAfterAnswer />

      {home.kpis.length > 0 && (
        <section aria-labelledby="home-kpis">
          <h2 id="home-kpis" className={styles.heading}>
            KPIs{' '}
            <Link href="/kpis" className={styles.seeAll}>
              See all
            </Link>
          </h2>
          <ul className={styles.tiles}>
            {home.kpis.map((k) => {
              const firing = home.firingAlerts.some((a) => a.kpiId === k.id);
              return (
                <li key={k.id} className={`card ${styles.tile} ${firing ? styles.tileFiring : ''}`}>
                  <Link href={kpiPath(k.id)} className={styles.tileName}>
                    {k.name}
                  </Link>
                  <strong className={styles.tileValue}>{k.value ? formatNumber(k.value.value) : '—'}</strong>
                  <span className={styles.muted}>
                    {k.status === 'paused' && <span className="tag">paused</span>}{' '}
                    {k.value && <time dateTime={k.value.at.toISOString()}>as of {formatInZone(k.value.at, 'UTC')} UTC</time>}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className={styles.columns}>
        <section aria-labelledby="home-alerts" className="card">
          <h2 id="home-alerts" className={styles.heading}>
            Firing KPI Alerts
          </h2>
          {home.firingAlerts.length === 0 ? (
            <p className={styles.muted}>No KPI Alert is firing.</p>
          ) : (
            <ul className={styles.list}>
              {home.firingAlerts.map((a) => (
                <li key={a.id}>
                  <span className={`tag ${styles.firingTag}`}>firing</span>{' '}
                  <Link href={kpiPath(a.kpiId)}>
                    <strong>{a.name}</strong>
                  </Link>
                  <br />
                  <span className={styles.muted}>
                    {a.kpi.name} is {a.kpi.value ? formatNumber(a.kpi.value.value) : '—'} ({describeCondition(a.condition)})
                    {a.firedAt && <> · since {formatInZone(a.firedAt, a.timezone)}</>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="home-runs" className="card">
          <h2 id="home-runs" className={styles.heading}>
            Upcoming Report Runs{' '}
            <Link href="/reports" className={styles.seeAll}>
              See all
            </Link>
          </h2>
          {home.upcomingRuns.length === 0 ? (
            <p className={styles.muted}>
              No Report is scheduled. <Link href="/reports/new">Create a Report</Link>
            </p>
          ) : (
            <ul className={styles.list}>
              {home.upcomingRuns.map((r) => (
                <li key={r.id}>
                  <Link href={reportPath(r.id)}>
                    <strong>{r.title}</strong>
                  </Link>
                  <br />
                  <span className={styles.muted}>
                    <time dateTime={r.nextRunAt.toISOString()}>
                      {formatInZone(r.nextRunAt, r.timezone)} ({r.timezone})
                    </time>{' '}
                    · {describeSchedule(r.schedule)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section aria-labelledby="home-recent" className="card">
        <h2 id="home-recent" className={styles.heading}>
          Recent Conversations{' '}
          <Link href="/history" className={styles.seeAll}>
            See all
          </Link>
        </h2>
        {home.recentConversations.length === 0 ? (
          <p className={styles.muted}>None yet. Your Conversations will show up here.</p>
        ) : (
          <ul className={styles.list}>
            {home.recentConversations.map((c) => (
              <li key={c.id}>
                <Link href={`/chat/${c.id}`}>{c.title || 'Untitled'}</Link>{' '}
                <span className="tag">{c.forkedFrom ? 'fork' : c.source.kind}</span>{' '}
                <time className={styles.muted} dateTime={c.updatedAt.toISOString()}>
                  {formatInZone(c.updatedAt, 'UTC')} UTC
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
