import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError, type DataSourceView } from '@/core';
import { builtInDrivers } from '@/drivers';
import { DataSourceForm } from '@/web/components/DataSourceForm';
import { getCore } from '@/web/server-runtime';
import { OAUTH_CALLBACK_PATH } from '@/web/oauth';
import {
  connectDataSource,
  deleteDataSource,
  refreshDataSourceSchema,
  saveDataSource,
  saveExposedDatasets,
  testDataSource,
} from '../actions';
import styles from '../data-sources.module.css';

export const dynamic = 'force-dynamic';

const NOTICES: Record<string, string> = {
  saved: 'Saved.',
  refreshed: 'Schema refreshed.',
  exposed: 'Exposed Datasets saved.',
  connected: 'Connected.',
};

async function load(id: string): Promise<DataSourceView> {
  try {
    return await (await getCore()).dataSources.get(id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
}

export default async function DataSourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const [{ id }, { notice, error }] = await Promise.all([params, searchParams]);
  const ds = await load(id);
  const kind = builtInDrivers[ds.kind];

  return (
    <div className={styles.stack}>
      <Link href="/admin/data-sources">← All Data Sources</Link>
      {notice && NOTICES[notice] && <p className={styles.notice}>{NOTICES[notice]}</p>}
      {error && <p className={styles.error}>{error}</p>}

      <section className="card">
        <h1>{ds.name}</h1>
        {kind ? (
          <DataSourceForm
            kind={{ kind: kind.kind, label: kind.label, fields: kind.fields }}
            existing={{ id: ds.id, name: ds.name, config: ds.config, secrets: ds.secrets }}
            saveAction={saveDataSource}
            testAction={testDataSource}
          />
        ) : (
          <p>This Data Source kind ({ds.kind}) is no longer supported.</p>
        )}
      </section>

      {kind?.oauth && (
        <section className={`card ${styles.stack}`}>
          <header className={styles.header}>
            <h2>Connection</h2>
            <span className="tag">{ds.connected ? 'connected' : 'not connected'}</span>
          </header>
          <p className={styles.muted}>
            Sign in to {kind.oauth.providerLabel} as the read-only integration user Botley should query as. The
            tokens are stored encrypted and refreshed automatically. Callback URL to register:{' '}
            <code>{OAUTH_CALLBACK_PATH}</code> on your Botley URL.
          </p>
          <form action={connectDataSource}>
            <input type="hidden" name="id" value={ds.id} />
            <button type="submit" className="btn btn--cyan">
              {ds.connected ? 'Reconnect' : 'Connect'} to {kind.oauth.providerLabel}
            </button>
          </form>
        </section>
      )}

      <section className={`card ${styles.stack}`}>
        <header className={styles.header}>
          <h2>Datasets</h2>
          <form action={refreshDataSourceSchema}>
            <input type="hidden" name="id" value={ds.id} />
            <button type="submit" className="btn btn--cyan">
              {ds.schemaRefreshedAt ? 'Refresh schema' : 'Introspect schema'}
            </button>
          </form>
        </header>
        <p className={styles.muted}>
          Only Exposed Datasets are visible to Botley.
          {ds.schemaRefreshedAt && ` Last refreshed ${ds.schemaRefreshedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`}
        </p>
        {ds.datasets.length > 0 && (
          <form action={saveExposedDatasets} className={styles.stack}>
            <input type="hidden" name="id" value={ds.id} />
            <div className={styles.datasets}>
              {ds.datasets.map((d) => (
                <label key={d.id} className={styles.dataset}>
                  <input type="checkbox" name="dataset" value={d.id} defaultChecked={d.exposed} />
                  <span>
                    <strong>{d.id}</strong> <span className="tag">{d.kind}</span>
                  </span>
                  <span className={styles.columns}>
                    {d.columns.map((c) => `${c.name} ${c.nativeType}`).join(', ')}
                  </span>
                </label>
              ))}
            </div>
            <div>
              <button type="submit" className="btn">
                Save Exposed Datasets
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="card">
        <h2>Delete</h2>
        <p className={styles.muted}>Botley will stop using this Data Source. This cannot be undone.</p>
        <form action={deleteDataSource}>
          <input type="hidden" name="id" value={ds.id} />
          <button type="submit" className={`btn ${styles.danger}`}>
            Delete {ds.name}
          </button>
        </form>
      </section>
    </div>
  );
}
