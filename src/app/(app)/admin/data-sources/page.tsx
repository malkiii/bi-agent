import Link from 'next/link';
import { builtInDrivers } from '@/drivers';
import { getCore } from '@/web/server-runtime';
import styles from './data-sources.module.css';

export const dynamic = 'force-dynamic';

export default async function DataSourcesPage() {
  const dataSources = await (await getCore()).dataSources.list();
  return (
    <section className={`card ${styles.stack}`}>
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
        <p className={styles.muted}>No Data Sources yet. Add one to let Botley answer questions about it.</p>
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
