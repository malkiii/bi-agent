import Link from 'next/link';
import { MAX_UPLOAD_BYTES } from '@/core';
import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';
import { deleteUploadAction } from '@/web/uploads/actions';
import { UploadForm } from '@/web/uploads/UploadForm';
import styles from '@/web/catalog/catalog.module.css';

export const metadata = { title: 'Uploads · BIBot' };
export const dynamic = 'force-dynamic';

const NOTICES: Record<string, string> = { deleted: 'Dataset deleted.' };

/** Upload CSV/XLSX files as Datasets, and see what everyone has uploaded. */
export default async function UploadsPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const [user, { notice, error }] = await Promise.all([requireUser(), searchParams]);
  const datasets = await (await getCore()).uploads.list();
  const isAdmin = user.role === 'admin';

  return (
    <div className={styles.stack}>
      <h1>Uploads</h1>
      {notice && NOTICES[notice] && <p className={styles.notice}>{NOTICES[notice]}</p>}
      {error && <p className={styles.error}>{error}</p>}

      <UploadForm existingDatasets={datasets.map((d) => d.datasetId)} maxBytes={MAX_UPLOAD_BYTES} />

      <section className={`card ${styles.stack}`}>
        <h2>Uploaded Datasets</h2>
        {datasets.length === 0 ? (
          <p className={styles.muted}>Nothing uploaded yet.</p>
        ) : (
          datasets.map((d) => (
            <article key={d.datasetId} className={styles.dataset}>
              <h3 className={styles.datasetTitle}>
                <code>{d.datasetId}</code>
                <span className="tag">{d.rowCount} rows</span>
              </h3>
              <p className={styles.muted}>
                From {d.filename}
                {d.sheet && !d.filename.toLowerCase().endsWith('.csv') && ` (sheet ${d.sheet})`}, updated{' '}
                {d.updatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC by {d.updatedBy}.
              </p>
              <p className={styles.muted}>
                <code>{d.columns.map((c) => `${c.name} ${c.type}`).join(', ')}</code>
              </p>
              <div className={styles.row}>
                <Link href={`/catalog#${encodeURIComponent(`${d.dataSourceId}:${d.datasetId}`)}`}>In the catalog</Link>
                {isAdmin && (
                  <form action={deleteUploadAction}>
                    <input type="hidden" name="datasetId" value={d.datasetId} />
                    <button type="submit" className={`btn ${styles.danger}`}>
                      Delete
                    </button>
                  </form>
                )}
              </div>
            </article>
          ))
        )}
      </section>
    </div>
  );
}
