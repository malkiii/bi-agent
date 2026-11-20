'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { UploadChoice, UploadPreview } from '@/core';
import { UPLOAD_COLUMN_TYPES, type UploadColumnType } from '@/core/uploads/storage';
import { useBotley } from '@/web/botley/BotleyProvider';
import styles from './UploadWizard.module.css';

const MAX_BYTES = 50 * 1024 * 1024;

interface ExistingDataset {
  id: string;
  name: string;
  columns: string[];
}

type Mode = 'create' | 'replace' | 'append' | 'skip';

interface SheetState {
  mode: Mode;
  name: string;
  datasetId: string;
  types: UploadColumnType[];
}

/** Upload → preview with inferred column types → corrections and per-sheet choice → save. */
export function UploadWizard({ datasets }: { datasets: ExistingDataset[] }) {
  const router = useRouter();
  const { setBotleyState, settleBotley } = useBotley();
  const [preview, setPreview] = useState<UploadPreview | null>(null);
  const [sheets, setSheets] = useState<SheetState[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function upload(file: File) {
    setError(null);
    setSaved(null);
    if (file.size > MAX_BYTES) {
      setError(`Files can be at most 50 MB; this one is ${(file.size / (1024 * 1024)).toFixed(1)} MB.`);
      setBotleyState('error');
      return;
    }
    setBusy(true);
    setBotleyState('thinking');
    try {
      const body = new FormData();
      body.set('file', file);
      const response = await fetch('/api/uploads/preview', { method: 'POST', body });
      const data = (await response.json().catch(() => ({ error: 'The upload failed. Try again.' }))) as
        | UploadPreview
        | { error: string };
      if ('error' in data) throw new Error(data.error);
      setPreview(data);
      setSheets(
        data.sheets.map((s) => ({
          mode: 'create',
          name: s.name,
          datasetId: datasets[0]?.id ?? '',
          types: s.columns.map((c) => c.type),
        })),
      );
      settleBotley();
    } catch (e) {
      setError((e as Error).message);
      setBotleyState('error');
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!preview) return;
    const choices: UploadChoice[] = [];
    preview.sheets.forEach((sheet, i) => {
      const s = sheets[i]!;
      if (s.mode === 'create') choices.push({ sheet: sheet.index, mode: 'create', name: s.name, types: s.types });
      if (s.mode === 'replace') choices.push({ sheet: sheet.index, mode: 'replace', datasetId: s.datasetId, types: s.types });
      if (s.mode === 'append') choices.push({ sheet: sheet.index, mode: 'append', datasetId: s.datasetId });
    });
    if (choices.length === 0) {
      setError('Choose at least one sheet to save.');
      return;
    }
    setBusy(true);
    setError(null);
    setBotleyState('thinking');
    try {
      const response = await fetch('/api/uploads/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ previewId: preview.id, choices }),
      });
      const data = (await response.json().catch(() => ({ error: 'Saving failed. Try again.' }))) as
        | { datasets: { id: string; name: string }[] }
        | { error: string };
      if ('error' in data) throw new Error(data.error);
      setSaved(`Saved ${data.datasets.map((d) => `${d.name} (${d.id})`).join(', ')}. Botley can answer questions about it now.`);
      setPreview(null);
      setSheets([]);
      setBotleyState('success');
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setBotleyState('error');
    } finally {
      setBusy(false);
    }
  }

  const update = (i: number, change: Partial<SheetState>) =>
    setSheets((all) => all.map((s, j) => (j === i ? { ...s, ...change } : s)));

  return (
    <div className={styles.wizard}>
      {!preview && (
        <label className={styles.drop}>
          <span>{busy ? 'Reading the file…' : 'Choose a CSV or XLSX file'}</span>
          <input
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
              e.target.value = '';
            }}
          />
        </label>
      )}

      {error && <p className={styles.error}>{error}</p>}
      {saved && <p className={styles.success}>{saved}</p>}

      {preview && (
        <>
          <p className={styles.muted}>
            <strong>{preview.fileName}</strong>: check each column&apos;s type, then choose what to do with each sheet.
          </p>
          {preview.sheets.map((sheet, i) => {
            const s = sheets[i]!;
            return (
              <fieldset key={sheet.index} className={styles.sheet} disabled={busy}>
                <legend>
                  {sheet.name} <span className="tag">{sheet.rowCount.toLocaleString('en')} rows</span>
                </legend>

                <div className={styles.controls}>
                  <select value={s.mode} onChange={(e) => update(i, { mode: e.target.value as Mode })} className={styles.input}>
                    <option value="create">Create a new Dataset</option>
                    {datasets.length > 0 && <option value="replace">Replace an existing Dataset</option>}
                    {datasets.length > 0 && <option value="append">Append to an existing Dataset</option>}
                    <option value="skip">Skip this sheet</option>
                  </select>
                  {s.mode === 'create' && (
                    <input
                      value={s.name}
                      onChange={(e) => update(i, { name: e.target.value })}
                      placeholder="Dataset name"
                      aria-label="Dataset name"
                      className={styles.input}
                    />
                  )}
                  {(s.mode === 'replace' || s.mode === 'append') && (
                    <select
                      value={s.datasetId}
                      onChange={(e) => update(i, { datasetId: e.target.value })}
                      aria-label="Dataset"
                      className={styles.input}
                    >
                      {datasets.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name} ({d.id})
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                {s.mode === 'append' && (
                  <p className={styles.muted}>
                    Append needs the same columns ({datasets.find((d) => d.id === s.datasetId)?.columns.join(', ')}); values
                    are converted to the Dataset&apos;s types.
                  </p>
                )}

                {s.mode !== 'skip' && (
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          {sheet.columns.map((c, col) => (
                            <th key={c.name}>
                              <span>{c.name}</span>
                              {s.mode !== 'append' && (
                                <select
                                  value={s.types[col]}
                                  aria-label={`Type of ${c.name}`}
                                  onChange={(e) =>
                                    update(i, {
                                      types: s.types.map((t, k) => (k === col ? (e.target.value as UploadColumnType) : t)),
                                    })
                                  }
                                  className={styles.typeSelect}
                                >
                                  {UPLOAD_COLUMN_TYPES.map((t) => (
                                    <option key={t} value={t}>
                                      {t}
                                    </option>
                                  ))}
                                </select>
                              )}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sheet.sampleRows.map((row, r) => (
                          <tr key={r}>
                            {row.map((cell, col) => (
                              <td key={col}>{cell ?? <span className={styles.muted}>empty</span>}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </fieldset>
            );
          })}
          <div className={styles.actions}>
            <button type="button" className="btn" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => {
                setPreview(null);
                setSheets([]);
              }}
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
