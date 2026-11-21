import Link from 'next/link';
import { formatNumber, kpiPath } from '@/core';
import { Botley } from '@/web/components/Botley';
import chat from '@/web/chat/chat.module.css';
import { requireUser } from '@/web/current-user';
import styles from '@/web/reports/reports.module.css';
import { getCore } from '@/web/server-runtime';

export const metadata = { title: 'KPIs · Botley' };
export const dynamic = 'force-dynamic';

/** Every KPI (they have no owner), with its latest value. */
export default async function KpisPage() {
  const user = await requireUser();
  const core = await getCore();
  const [kpis, alerts] = await Promise.all([core.kpis.list(user.slackUserId), core.kpis.listAlerts(user.slackUserId)]);
  return (
    <div className={chat.page}>
      <header className={chat.conversationHeader}>
        <h1>KPIs</h1>
        <Link href="/kpis/new" className="btn">
          New KPI
        </Link>
      </header>
      {kpis.length === 0 ? (
        <div className={chat.hero}>
          <Botley rest="empty" size={72} />
          <p className={chat.muted}>No KPIs yet. A KPI is a named single number, such as Daily Orders, that KPI Alerts can watch.</p>
        </div>
      ) : (
        <ul className={styles.list}>
          {kpis.map((k) => {
            const fired = alerts.filter((a) => a.kpiId === k.id && a.state === 'fired').length;
            return (
              <li key={k.id} className={`card ${styles.item}`}>
                <span>
                  <Link href={kpiPath(k.id)}>
                    <strong>{k.name}</strong>
                  </Link>{' '}
                  {k.status !== 'active' && <span className="tag">{k.status}</span>}{' '}
                  {fired > 0 && <span className={`tag ${styles.failedTag}`}>{fired} firing</span>}
                </span>
                <strong className={styles.mono}>{k.value ? formatNumber(k.value.value) : '—'}</strong>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
