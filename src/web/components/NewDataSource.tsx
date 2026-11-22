'use client';

import { useState } from 'react';
import { parseConnectionUrl } from '@/core/data-sources/connection-url';
import type { DriverField } from '@/core/data-sources/driver';
import { DataSourceForm, type DataSourceFormProps } from './DataSourceForm';
import styles from './DataSourceForm.module.css';

type Kind = { kind: string; label: string; fields: readonly DriverField[] };

/**
 * The new Data Source form, with a box to paste a connection URL: it picks the kind the URL
 * points at and fills in the fields, which the admin then reviews, tests and saves.
 */
export function NewDataSource({
  kinds,
  initialKind,
  saveAction,
  testAction,
}: {
  /** The kinds a connection URL can select. */
  kinds: readonly Kind[];
  initialKind: Kind;
  saveAction: DataSourceFormProps['saveAction'];
  testAction: DataSourceFormProps['testAction'];
}) {
  const [kind, setKind] = useState(initialKind);
  const [prefill, setPrefill] = useState<{ values: Record<string, string>; version: number }>({ values: {}, version: 0 });
  const [url, setUrl] = useState('');
  /** The URL the form was last filled from: leaving the box again must not undo later edits. */
  const [applied, setApplied] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const detectable = kinds.some((k) => k.kind === kind.kind);

  /** Fills the form from `text`; runs on paste and when leaving the box, so typing doesn't reset the form. */
  function detect(text: string) {
    if (!text.trim()) return setStatus(null);
    if (text === applied) return;
    const parsed = parseConnectionUrl(text);
    if (!parsed.ok) return setStatus({ ok: false, text: parsed.error });
    const next = kinds.find((k) => k.kind === parsed.kind);
    if (!next) return setStatus({ ok: false, text: 'BIBot cannot connect to this kind of database yet.' });
    setApplied(text);
    setKind(next);
    // A remount (new key) restarts the form from these values.
    setPrefill((p) => ({ values: { name: parsed.values.database ?? '', ...parsed.values }, version: p.version + 1 }));
    setStatus({ ok: true, text: `Detected ${next.label}. The fields below are filled in: check them, then test and save.` });
  }

  return (
    <>
      {detectable && (
        <label className={styles.detect}>
          <span className={styles.label}>Connection URL (optional)</span>
          <input
            type="password"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onPaste={(e) => {
              const text = e.clipboardData.getData('text');
              setUrl(text);
              detect(text);
              e.preventDefault();
            }}
            onBlur={(e) => detect(e.target.value)}
            placeholder="postgres://user:password@host:5432/database"
            autoComplete="off"
            className={styles.input}
          />
          <span className={styles.help}>
            Paste a postgres://, mysql://, mariadb://, sqlserver:// or mongodb:// URL to fill in the form. It is not saved
            as is.
          </span>
          {status && <span className={status.ok ? styles.success : styles.error}>{status.text}</span>}
        </label>
      )}
      <DataSourceForm
        key={`${kind.kind}-${prefill.version}`}
        kind={kind}
        initialValues={prefill.values}
        saveAction={saveAction}
        testAction={testAction}
      />
    </>
  );
}
