import Link from 'next/link';
import type { ReactNode } from 'react';
import { signOut } from '@/auth';
import type { User } from '@/core';
import { PendingButton } from './PendingButton';
import styles from './AppShell.module.css';

/** The signed-in frame: header with navigation and the user menu, then the page. */
export function AppShell({ user, children }: { user: User; children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand}>
          BIBot
        </Link>
        <nav className={styles.nav}>
          <Link href="/chat">Chat</Link>
          <Link href="/history">History</Link>
          <Link href="/reports">Reports</Link>
          <Link href="/kpis">KPIs</Link>
          <Link href="/catalog">Catalog</Link>
          <Link href="/uploads">Uploads</Link>
          {user.role === 'admin' && <Link href="/admin">Admin</Link>}
        </nav>
        <div className={styles.user}>
          <span>{user.name}</span>
          <span className="tag">{user.role}</span>
          <form
            action={async () => {
              'use server';
              await signOut({ redirectTo: '/signin' });
            }}
          >
            <PendingButton className="btn btn--ghost">Sign out</PendingButton>
          </form>
        </div>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
