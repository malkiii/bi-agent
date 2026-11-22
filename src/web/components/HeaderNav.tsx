'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import styles from './AppShell.module.css';

export interface NavLink {
  href: string;
  label: string;
}

/**
 * The header's page links (the current page highlighted) and the user menu passed as `children`.
 * On narrow screens both collapse behind a menu button.
 */
export function HeaderNav({ links, children }: { links: NavLink[]; children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      <button
        type="button"
        className={styles.menuButton}
        aria-expanded={open}
        aria-controls="app-menu"
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.burger} data-open={open} aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="sr-only">{open ? 'Close menu' : 'Open menu'}</span>
      </button>
      <div id="app-menu" className={styles.menu} data-open={open}>
        <div className={styles.menuInner}>
          <nav className={styles.nav} aria-label="Main">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={styles.navLink}
                aria-current={isActive(l.href) ? 'page' : undefined}
                onClick={() => setOpen(false)}
              >
                {l.label}
              </Link>
            ))}
          </nav>
          {children}
        </div>
      </div>
    </>
  );
}
