'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { UploadColumnType, UploadMode, UploadPreview } from '@/core';
import { confirmUploadAction } from './actions';
import styles from '@/web/catalog/catalog.module.css';

const TYPES: readonly UploadColumnType[] = ['string', 'integer', 'number', 'boolean', 'date', 'datetime'];
const TYPE_LABELS: Record<UploadColumnType, string> = {
  string: 'Text',
  integer: 'Whole number',
  number: 'Decimal number',
  boolean: 'Yes / no',
  date: 'Date',
  datetime: 'Date and time',
};

interface SheetChoice {
  include: boolean;
  mode: UploadMode;
  datasetName: string;
  columnTypes: Record<string, UploadColumnType>;
}

const formatMb = (bytes: number) => `${(Math.ceil((bytes / 1024 / 1024) * 10) / 10).toFixed(1)} MB`;

/**
 * Two steps: pick a file (posted to /api/uploads for the preview), then review each sheet:
 * its Dataset name, New / Replace / Append, and corrected column types, and confirm.
 */
export function UploadForm({ existingDatasets, maxBytes }: { existingDatasets: string[]; maxBytes: number }) {
  const router = useRouter();
  const [preview, setPreview] = useState<UploadPreview | null>(null);
  const [choices, setChoices] = useState<SheetChoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, startSaving] = useTransition();

  async function upload(file: File) {
    setError(null);
    setNotice(null);
    setPreview(null);
    if (file.size > maxBytes) {
      setError(`This file is ${formatMb(file.size)}; uploads can be at most ${formatMb(maxBytes)}.`);
      return;
    }
    setUploading(true);
    try {
      const body = new FormData();
      body.set('file', file);
      const response = await fetch('/api/uploads', { method: 'POST', body });
      const json = (await response.json().catch(() => ({ error: 'The upload failed. Try again.' }))) as
        | UploadPreview
        | { error: string };
      if (!response.ok || 'error' in json) {
        setError('error' in json ? json.error : 'The upload failed. Try again.');
        return;
      }
      setPreview(json);
      setChoices(
        json.sheets.map((s) => ({
          include: true,
          mode: existingDatasets.includes(s.datasetName) ? 'replace' : 'new',
          datasetName: s.datasetName,
          columnTypes: Object.fromEntries(s.columns.map((c) => [c.name, c.type])),
        })),
      );
    } finally {
      setUploading(false);
    }
  }

  function update(index: number, change: Partial<SheetChoice>) {
    setChoices((current) => current.map((c, i) => (i === index ? { ...c, ...change } : c)));
  }

  function confirm() {
    if (!preview) return;
    setError(null);
    startSaving(async () => {
      const result = await confirmUploadAction({
        uploadId: preview.uploadId,
        sheets: preview.sheets.flatMap((sheet, i) => {
          const choice = choices[i]!;
          return choice.include
            ? [{ sheet: sheet.sheet, datasetName: choice.datasetName, mode: choice.mode, columnTypes: choice.columnTypes }]
            : [];
        }),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPreview(null);
      setNotice(`Saved ${result.datasetIds.join(', ')}. You can ask BIBot about it now.`);
      router.refresh();
    });
  }

  return (
    <section className={`card ${styles.stack}`}>
      <h2>Upload a file</h2>
      <p className={styles.muted}>
        CSV or XLSX, up to 50 MB. The first row holds the column names; each sheet of a workbook becomes its own
        Dataset, shared with everyone in the Uploads Data Source.
      </p>
      <label className={styles.field}>
        <span>File</span>
        <input
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          disabled={uploading || saving}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
            e.target.value = '';
          }}
        />
      </label>
      {uploading && <p className={styles.muted}>Reading the file…</p>}
      {error && <p className={styles.error}>{error}</p>}
      {notice && <p className={styles.notice}>{notice}</p>}

      {preview && (
        <div className={styles.stack}>
          <h3>Check {preview.filename}</h3>
          {preview.sheets.map((sheet, i) => {
            const choice = choices[i]!;
            return (
              <fieldset key={sheet.sheet} className={styles.sheet}>
                <legend>
                  <label className={styles.row}>
                    <input
                      type="checkbox"
                      checked={choice.include}
                      onChange={(e) => update(i, { include: e.target.checked })}
                    />
                    <strong>{sheet.sheet}</strong>
                    <span className={styles.muted}>{sheet.rowCount} rows</span>
                  </label>
                </legend>
                {choice.include && (
                  <>
                    <div className={styles.row}>
                      <label className={styles.field}>
                        <span>Save as</span>
                        <select
                          value={choice.mode}
                          onChange={(e) => {
                            const mode = e.target.value as UploadMode;
                            const datasetName =
                              mode === 'new' || existingDatasets.includes(choice.datasetName)
                                ? choice.datasetName
                                : (existingDatasets[0] ?? '');
                            update(i, { mode, datasetName });
                          }}
                        >
                          <option value="new">New Dataset</option>
                          <option value="replace" disabled={existingDatasets.length === 0}>
                            Replace an existing Dataset
                          </option>
                          <option value="append" disabled={existingDatasets.length === 0}>
                            Append to an existing Dataset
                          </option>
                        </select>
                      </label>
                      <label className={styles.field}>
                        <span>Dataset name</span>
                        {choice.mode === 'new' ? (
                          <input
                            value={choice.datasetName}
                            pattern="[a-z_][a-z0-9_]*"
                            title="Lowercase letters, digits and underscores"
                            onChange={(e) => update(i, { datasetName: e.target.value })}
                          />
                        ) : (
                          <select value={choice.datasetName} onChange={(e) => update(i, { datasetName: e.target.value })}>
                            {existingDatasets.map((id) => (
                              <option key={id} value={id}>
                                {id}
                              </option>
                            ))}
                          </select>
                        )}
                      </label>
                    </div>
                    {choice.mode === 'append' && (
                      <p className={styles.muted}>Append needs exactly the same columns and types as the Dataset.</p>
                    )}
                    <div className={styles.tableScroll}>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            {sheet.columns.map((c) => (
                              <th key={c.name}>
                                <code>{c.name}</code>
                                {c.header !== c.name && <div className={styles.muted}>{c.header}</div>}
                                <select
                                  aria-label={`Type of ${c.name}`}
                                  value={choice.columnTypes[c.name]}
                                  onChange={(e) =>
                                    update(i, {
                                      columnTypes: { ...choice.columnTypes, [c.name]: e.target.value as UploadColumnType },
                                    })
                                  }
                                >
                                  {TYPES.map((t) => (
                                    <option key={t} value={t}>
                                      {TYPE_LABELS[t]}
                                    </option>
                                  ))}
                                </select>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {sheet.sampleRows.map((row, r) => (
                            <tr key={r}>
                              {row.map((cell, c) => (
                                <td key={c}>{cell}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </fieldset>
            );
          })}
          <div className={styles.row}>
            <button
              type="button"
              className="btn btn--pink"
              disabled={saving || !choices.some((c) => c.include)}
              onClick={confirm}
            >
              {saving ? 'Saving…' : 'Save Datasets'}
            </button>
            <button type="button" className="btn btn--ghost" disabled={saving} onClick={() => setPreview(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
