import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';
import { RoleForm } from './RoleForm';
import styles from './users.module.css';

export const dynamic = 'force-dynamic';

const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

/** Admin: users with role and last sign-in. Access: src/proxy.ts plus `users.list` in the App Core. */
export default async function UsersPage() {
  const me = await requireUser();
  const users = await (await getCore()).users.list(me.slackUserId);
  return (
    <section className="card">
      <h1>Users &amp; roles</h1>
      <p className={styles.lead}>
        Admins manage Data Sources, settings and roles. There must always be at least one admin.
      </p>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Last sign-in (UTC)</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.slackUserId}>
                <td>
                  <div>{u.name}</div>
                  {u.email && <div className={styles.muted}>{u.email}</div>}
                </td>
                <td>
                  <span className="tag">{u.role}</span>
                </td>
                <td>
                  <time dateTime={u.lastSignInAt.toISOString()}>{dateFormat.format(u.lastSignInAt)}</time>
                </td>
                <td>
                  <RoleForm slackUserId={u.slackUserId} role={u.role} isSelf={u.slackUserId === me.slackUserId} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
