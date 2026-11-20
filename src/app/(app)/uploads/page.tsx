import { Botley } from '@/web/components/Botley';
import { UploadWizard } from '@/web/components/UploadWizard';
import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';
import { deleteUploadedDataset } from './actions';
import styles from './uploads.module.css';

export const dynamic = 'force-dynamic';

export default async function UploadsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const [user, { error }] = await Promise.all([requireUser(), searchParams]);
  const datasets = await (await getCore()).uploads.list();

  return (
    <div className={styles.stack}>
      <section className={`card ${styles.stack}`}>
        <h1>Upload a spreadsheet</h1>
        <p className={styles.muted}>
          CSV or XLSX, up to 50 MB. The first row must be the header. Each sheet becomes a Dataset in the shared
          Uploads Data Source, so everyone can ask Botley about it.
        </p>
        <UploadWizard datasets={datasets.map((d) => ({ id: d.id, name: d.name, columns: d.columns.map((c) => c.name) }))} />
      </section>

      <section className={`card ${styles.stack}`}>
        <h2>Uploaded Datasets</h2>
        {error && <p className={styles.error}>{error}</p>}
        {datasets.length === 0 ? (
          <div className={styles.row}>
            <Botley rest="empty" size={96} />
            <p className={styles.muted}>Nothing uploaded yet.</p>
          </div>
        ) : (
          <ul className={styles.list}>
            {datasets.map((d) => (
              <li key={d.id} className={styles.item}>
                <div className={styles.row}>
                  <strong>{d.name}</strong>
                  <code className={styles.code}>{d.id}</code>
                  <span className="tag">{d.rowCount.toLocaleString('en')} rows</span>
                  <span className={styles.muted}>
                    from {d.fileName}
                    {d.sheetName && d.fileName.toLowerCase().endsWith('.xlsx') ? ` (${d.sheetName})` : ''}, updated{' '}
                    {d.updatedAt.toISOString().slice(0, 10)}
                  </span>
                </div>
                <span className={styles.columns}>{d.columns.map((c) => `${c.name} ${c.type}`).join(', ')}</span>
                {user.role === 'admin' && (
                  <form action={deleteUploadedDataset}>
                    <input type="hidden" name="id" value={d.id} />
                    <button type="submit" className={`btn ${styles.danger}`}>
                      Delete
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
