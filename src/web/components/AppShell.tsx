import Link from 'next/link';
import type { ReactNode } from 'react';
import { signOut } from '@/auth';
import type { User } from '@/core';
import { HeaderNav, type NavLink } from './HeaderNav';
import { PendingButton } from './PendingButton';
import styles from './AppShell.module.css';

const LINKS: NavLink[] = [
  { href: '/chat', label: 'Chat' },
  { href: '/history', label: 'History' },
  { href: '/reports', label: 'Reports' },
  { href: '/kpis', label: 'KPIs' },
  { href: '/catalog', label: 'Catalog' },
  { href: '/uploads', label: 'Uploads' },
];

/** The signed-in frame: header with navigation and the user menu, then the page. */
export function AppShell({ user, children }: { user: User; children: ReactNode }) {
  const links = user.role === 'admin' ? [...LINKS, { href: '/admin', label: 'Admin' }] : LINKS;
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand}>
          BIBot
        </Link>
        <HeaderNav links={links}>
          <div className={styles.user}>
            <span className={styles.userName}>{user.name}</span>
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
        </HeaderNav>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
