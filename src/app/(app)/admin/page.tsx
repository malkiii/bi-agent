import Link from 'next/link';
import type { ReactNode } from 'react';
import styles from './admin.module.css';

export const metadata = { title: 'Admin · BIBot' };

type Accent = 'yellow' | 'pink' | 'cyan' | 'lime';

interface Tile {
  href: string;
  title: string;
  description: ReactNode;
  accent: Accent;
  icon: ReactNode;
}

/** 24px line icons, drawn in the current text colour. */
const Icon = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

const TILES: Tile[] = [
  {
    href: '/admin/data-sources',
    title: 'Data Sources',
    description: 'Connections, credentials and Exposed Datasets.',
    accent: 'yellow',
    icon: (
      <Icon>
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
        <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
      </Icon>
    ),
  },
  {
    href: '/catalog',
    title: 'Catalog',
    description: 'Dataset and column descriptions and Synonyms (Edit on each Dataset).',
    accent: 'cyan',
    icon: (
      <Icon>
        <path d="M4 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4z" />
        <path d="M20 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z" />
      </Icon>
    ),
  },
  {
    href: '/admin/channels',
    title: 'Channel Defaults',
    description: 'The Data Sources BIBot uses in each Slack channel.',
    accent: 'pink',
    icon: (
      <Icon>
        <path d="M9 3 7 21M17 3l-2 18M4 8h17M3 16h17" />
      </Icon>
    ),
  },
  {
    href: '/admin/users',
    title: 'Users & roles',
    description: 'Who can sign in, and who is an admin.',
    accent: 'lime',
    icon: (
      <Icon>
        <circle cx="9" cy="8" r="3.5" />
        <path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5" />
        <circle cx="17.5" cy="9" r="2.5" />
        <path d="M17 14.5c2.3.2 4 1.8 4.5 4.5" />
      </Icon>
    ),
  },
  {
    href: '/admin/settings',
    title: 'Settings',
    description: 'The LLM provider and model.',
    accent: 'yellow',
    icon: (
      <Icon>
        <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
        <circle cx="16" cy="6" r="2" />
        <circle cx="10" cy="12" r="2" />
        <circle cx="18" cy="18" r="2" />
      </Icon>
    ),
  },
  {
    href: '/admin/audit',
    title: 'Audit log',
    description: 'Prompts, queries, token usage and who changed what.',
    accent: 'cyan',
    icon: (
      <Icon>
        <rect x="5" y="3" width="14" height="18" rx="2" />
        <path d="M9 8h6M9 12h6M9 16h3" />
      </Icon>
    ),
  },
  {
    href: '/admin/conversations',
    title: 'Conversations',
    description: 'Delete Conversations. Report Runs are deleted on their Report, uploaded Datasets on Uploads.',
    accent: 'pink',
    icon: (
      <Icon>
        <path d="M4 5h16v11H9l-5 4z" />
        <path d="M8 9h8M8 12h5" />
      </Icon>
    ),
  },
];

/** Admin area. Access is enforced in src/proxy.ts (routeAccess: everything under /admin). */
export default function AdminPage() {
  return (
    <div className={styles.page}>
      <header>
        <h1 className={styles.title}>Admin</h1>
        <p className={styles.lead}>Configure what BIBot can see, who can use it, and review what it has done.</p>
      </header>
      <ul className={styles.grid}>
        {TILES.map((t) => (
          <li key={t.href}>
            <Link href={t.href} className={styles.tile} data-accent={t.accent}>
              <span className={styles.icon}>{t.icon}</span>
              <span className={styles.tileTitle}>
                {t.title}
                <span className={styles.arrow} aria-hidden="true">
                  →
                </span>
              </span>
              <span className={styles.description}>{t.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
