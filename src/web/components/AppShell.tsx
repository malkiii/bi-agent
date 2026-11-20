import Link from 'next/link';
import type { ReactNode } from 'react';
import { signOut } from '@/auth';
import type { ThemePreference, User } from '@/core';
import { ThemeToggle } from '@/web/theme/ThemeToggle';
import { PendingButton } from './PendingButton';
import styles from './AppShell.module.css';

/** The signed-in frame: header with navigation and the user menu, then the page. */
export function AppShell({ user, theme, children }: { user: User; theme: ThemePreference; children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand}>
          Botley
        </Link>
        <nav className={styles.nav}>
          <Link href="/">Home</Link>
          <Link href="/chat">Chat</Link>
          <Link href="/uploads">Uploads</Link>
          {user.role === 'admin' && <Link href="/admin">Admin</Link>}
        </nav>
        <div className={styles.user}>
          <ThemeToggle initial={theme} />
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
