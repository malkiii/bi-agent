import Link from 'next/link';
import { builtInDrivers } from '@/drivers';
import { Botley } from '@/web/components/Botley';
import { getCore } from '@/web/server-runtime';
import styles from './data-sources.module.css';

export const dynamic = 'force-dynamic';

export default async function DataSourcesPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const [dataSources, { error }] = await Promise.all([(await getCore()).dataSources.list(), searchParams]);
  return (
    <section className={`card ${styles.stack}`}>
      {error && <p className={styles.error}>{error}</p>}
      <header className={styles.header}>
        <h1>Data Sources</h1>
        <div className={styles.row}>
          {Object.values(builtInDrivers).map((k) => (
            <Link key={k.kind} href={`/admin/data-sources/new?kind=${k.kind}`} className="btn">
              Add {k.label}
            </Link>
          ))}
        </div>
      </header>
      {dataSources.length === 0 ? (
        <div className={styles.row}>
          <Botley rest="empty" size={96} />
          <p className={styles.muted}>No Data Sources yet. Add one to let Botley answer questions about it.</p>
        </div>
      ) : (
        <ul className={styles.list}>
          {dataSources.map((ds) => (
            <li key={ds.id} className={styles.item}>
              <Link href={`/admin/data-sources/${ds.id}`} className={styles.name}>
                {ds.name}
              </Link>
              <span className="tag">{builtInDrivers[ds.kind]?.label ?? ds.kind}</span>
              <span className={styles.muted}>
                {ds.datasets.filter((d) => d.exposed).length} of {ds.datasets.length} Datasets exposed
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
