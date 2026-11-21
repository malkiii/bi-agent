import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError, type DataSourceView } from '@/core';
import { getCore } from '@/web/server-runtime';
import styles from '@/web/catalog/catalog.module.css';
import { saveDatasetDetails } from '../../actions';

export const dynamic = 'force-dynamic';

async function load(id: string): Promise<DataSourceView> {
  try {
    return await (await getCore()).dataSources.get(id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
}

/** Admin: descriptions and Synonyms of one Dataset (`?d=<dataset id>`) and its columns. */
export default async function DatasetDetailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ d?: string; notice?: string; error?: string }>;
}) {
  const [{ id }, { d, notice, error }] = await Promise.all([params, searchParams]);
  const ds = await load(id);
  const dataset = ds.datasets.find((x) => x.id === d);
  if (!dataset) notFound();

  return (
    <div className={styles.stack}>
      <div className={styles.row}>
        <Link href={`/admin/data-sources/${ds.id}`}>← {ds.name}</Link>
        <Link href={`/catalog#${encodeURIComponent(`${ds.id}:${dataset.id}`)}`}>View in the catalog</Link>
      </div>
      {notice === 'saved' && <p className={styles.notice}>Saved.</p>}
      {error && <p className={styles.error}>{error}</p>}

      <form action={saveDatasetDetails} className={`card ${styles.stack}`}>
        <input type="hidden" name="id" value={ds.id} />
        <input type="hidden" name="datasetId" value={dataset.id} />
        <h1>
          <code>{dataset.id}</code>
        </h1>
        <p className={styles.muted}>
          BIBot reads these when choosing what to query. Synonyms are business terms, separated by commas, e.g.
          “revenue, turnover” for a total amount column.
          {!dataset.exposed && ' This Dataset is not exposed, so BIBot does not see it yet.'}
        </p>
        <label className={styles.field}>
          <span>Description</span>
          <textarea name="description" rows={2} defaultValue={dataset.description ?? ''} />
        </label>
        <label className={styles.field}>
          <span>Synonyms</span>
          <input name="synonyms" defaultValue={(dataset.synonyms ?? []).join(', ')} />
        </label>

        <h2>Columns</h2>
        <div className={styles.tableScroll}>
          <table className={styles.columns}>
            <thead>
              <tr>
                <th>Column</th>
                <th>Description</th>
                <th>Synonyms</th>
              </tr>
            </thead>
            <tbody>
              {dataset.columns.map((c) => (
                <tr key={c.name}>
                  <td>
                    <code>{c.name}</code> <span className={styles.muted}>{c.type}</span>
                  </td>
                  <td className={styles.field}>
                    <input
                      name={`column.${c.name}.description`}
                      aria-label={`Description of ${c.name}`}
                      defaultValue={c.description ?? ''}
                    />
                  </td>
                  <td className={styles.field}>
                    <input
                      name={`column.${c.name}.synonyms`}
                      aria-label={`Synonyms of ${c.name}`}
                      defaultValue={(c.synonyms ?? []).join(', ')}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <button type="submit" className="btn btn--pink">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
