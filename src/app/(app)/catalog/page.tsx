import Link from 'next/link';
import type { CatalogDataset, CatalogDetails } from '@/core';
import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';
import styles from '@/web/catalog/catalog.module.css';

export const metadata = { title: 'Catalog · Botley' };
export const dynamic = 'force-dynamic';

/** The Dataset catalog: every Exposed Dataset with its description, columns and Synonyms. */
export default async function CatalogPage() {
  const user = await requireUser();
  const sources = (await (await getCore()).dataSources.list())
    .map((ds) => ({ ...ds, datasets: ds.datasets.filter((d) => d.exposed) }))
    .filter((ds) => ds.datasets.length > 0);
  const isAdmin = user.role === 'admin';

  return (
    <div className={styles.stack}>
      <h1>Catalog</h1>
      <p className={styles.muted}>
        What you can ask Botley about. Synonyms are business terms Botley maps to a Dataset or column.
        {isAdmin && ' As an admin you can edit descriptions and Synonyms.'}
      </p>
      {sources.length === 0 && (
        <p className={styles.muted}>
          No Datasets are exposed yet.{' '}
          {isAdmin ? <Link href="/admin/data-sources">Expose some</Link> : 'Ask an admin to expose some'}, or{' '}
          <Link href="/uploads">upload a file</Link>.
        </p>
      )}
      {sources.map((ds) => (
        <section key={ds.id} className={`card ${styles.stack}`}>
          <header className={styles.header}>
            <h2>{ds.name}</h2>
            <span className="tag">{ds.kind}</span>
          </header>
          {ds.datasets.map((d) => (
            <DatasetEntry
              key={d.id}
              dataset={d}
              anchor={`${ds.id}:${d.id}`}
              editHref={isAdmin ? `/admin/data-sources/${ds.id}/dataset?d=${encodeURIComponent(d.id)}` : undefined}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function DatasetEntry({ dataset, anchor, editHref }: { dataset: CatalogDataset; anchor: string; editHref?: string }) {
  return (
    <article id={anchor} className={styles.dataset}>
      <h3 className={styles.datasetTitle}>
        <code>{dataset.id}</code>
        <span className="tag">{dataset.kind}</span>
        {editHref && <Link href={editHref}>Edit</Link>}
      </h3>
      <Details details={dataset} />
      <div className={styles.tableScroll}>
        <table className={styles.columns}>
          <thead>
            <tr>
              <th>Column</th>
              <th>Type</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {dataset.columns.map((c) => (
              <tr key={c.name}>
                <td>
                  <code>{c.name}</code>
                </td>
                <td>{c.type}</td>
                <td>
                  <Details details={c} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function Details({ details }: { details: CatalogDetails }) {
  return (
    <>
      {details.description && <p className={styles.muted}>{details.description}</p>}
      {details.synonyms && details.synonyms.length > 0 && (
        <ul className={styles.synonyms} aria-label="Synonyms">
          {details.synonyms.map((s) => (
            <li key={s} className={styles.synonym}>
              {s}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
