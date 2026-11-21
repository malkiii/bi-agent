import Link from 'next/link';
import { describeSchedule } from '@/core';
import { Botley } from '@/web/components/Botley';
import chat from '@/web/chat/chat.module.css';
import { requireUser } from '@/web/current-user';
import styles from '@/web/reports/reports.module.css';
import { getCore } from '@/web/server-runtime';
import { formatInZone, statusLabel } from '@/web/reports/format';

export const metadata = { title: 'Reports · Botley' };
export const dynamic = 'force-dynamic';

/** Every Report (they have no owner), with its schedule and next run. */
export default async function ReportsPage() {
  const user = await requireUser();
  const reports = await (await getCore()).reports.list(user.slackUserId);
  return (
    <div className={chat.page}>
      <header className={chat.conversationHeader}>
        <h1>Reports</h1>
        <Link href="/reports/new" className="btn">
          New Report
        </Link>
      </header>
      {reports.length === 0 ? (
        <div className={chat.hero}>
          <Botley rest="empty" size={72} />
          <p className={chat.muted}>No Reports yet. A Report runs a Prompt on a schedule and posts each Report Run to Slack.</p>
        </div>
      ) : (
        <ul className={styles.list}>
          {reports.map((r) => (
            <li key={r.id} className={`card ${styles.item}`}>
              <span>
                <Link href={`/reports/${r.id}`}>
                  <strong>{r.title}</strong>
                </Link>{' '}
                <span className="tag">{statusLabel(r.status)}</span>
              </span>
              <span className={chat.muted}>
                {describeSchedule(r.schedule)} ({r.timezone})
                {r.nextRunAt && <> · next {formatInZone(r.nextRunAt, r.timezone)}</>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
