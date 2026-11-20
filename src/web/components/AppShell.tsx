import Link from 'next/link';
import type { ReactNode } from 'react';
import { signOut } from '@/auth';
import type { User } from '@/core';
import styles from './AppShell.module.css';

/** The signed-in frame: header with navigation and the user menu, then the page. */
export function AppShell({ user, children }: { user: User; children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand}>
          Botley
        </Link>
        <nav className={styles.nav}>
          <Link href="/">Home</Link>
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
            <button type="submit" className="btn btn--ghost">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
