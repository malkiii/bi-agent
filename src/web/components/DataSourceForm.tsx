'use client';

import { useActionState, useState } from 'react';
import type { DriverField } from '@/core/data-sources/driver';
import type { DataSourceFormState } from '@/app/(app)/admin/data-sources/actions';
import styles from './DataSourceForm.module.css';

type FormAction = (prev: DataSourceFormState, formData: FormData) => Promise<DataSourceFormState>;

export interface DataSourceFormProps {
  kind: { kind: string; label: string; fields: readonly DriverField[] };
  /** Present when editing. Secrets are only "set" flags; their values never reach the browser. */
  existing?: { id: string; name: string; config: Record<string, unknown>; secrets: Record<string, boolean> };
  saveAction: FormAction;
  testAction: FormAction;
  /** Values to start a new Data Source with (e.g. from a pasted connection URL), by field key. */
  initialValues?: Record<string, string>;
}

/** Create/edit form for one Data Source kind, rendered from the kind's field descriptors. */
export function DataSourceForm({ kind, existing, saveAction, testAction, initialValues }: DataSourceFormProps) {
  const [saveState, save, saving] = useActionState(saveAction, {});
  const [testState, test, testing] = useActionState(testAction, {});
  // Controlled values: React resets uncontrolled forms after every action, including "Test".
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = { name: existing?.name ?? initialValues?.name ?? '' };
    for (const f of kind.fields) {
      const stored = existing?.config[f.key];
      initial[f.key] =
        initialValues?.[f.key] ?? (f.secret ? '' : stored !== undefined ? String(stored) : (f.defaultValue ?? ''));
    }
    return initial;
  });
  const set = (key: string) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [key]: e.target.value }));

  const state = testing || saving ? {} : { ...testState, ...saveState };
  const fieldErrors = { ...testState.fieldErrors, ...saveState.fieldErrors };
  const message = saveState.message ?? testState.message;

  return (
    <form action={save} className={styles.form}>
      <input type="hidden" name="kind" value={kind.kind} />
      {existing && <input type="hidden" name="id" value={existing.id} />}

      <p className={styles.notice}>
        BIBot only ever runs read-only queries, but give it a <strong>read-only database user</strong> anyway.
        Every signed-in member can ask about every Data Source, so don&apos;t connect data some members must not see.
      </p>

      <Field label="Name" error={fieldErrors.name}>
        <input name="name" value={values.name} onChange={set('name')} required className={styles.input} />
      </Field>

      {kind.fields.map((f) => {
        const isSet = f.secret && existing?.secrets[f.key];
        return (
          <Field key={f.key} label={f.label} error={fieldErrors[f.key]} help={f.help}>
            {f.input === 'select' ? (
              <select name={f.key} value={values[f.key]} onChange={set(f.key)} className={styles.input}>
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                name={f.key}
                type={f.input}
                value={values[f.key]}
                onChange={set(f.key)}
                required={f.required && !isSet}
                placeholder={isSet ? 'Set. Leave blank to keep it.' : undefined}
                autoComplete={f.secret ? 'new-password' : 'off'}
                className={styles.input}
              />
            )}
            {isSet && <span className="tag">set</span>}
          </Field>
        );
      })}

      {message && <p className={styles.error}>{message}</p>}
      {state.test?.ok === true && <p className={styles.success}>Connection works.</p>}
      {state.test?.ok === false && <p className={styles.error}>Connection failed: {state.test.error}</p>}

      <div className={styles.actions}>
        <button type="submit" formAction={test} className="btn btn--cyan" disabled={testing}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <button type="submit" className="btn" disabled={saving}>
          {saving ? 'Saving…' : existing ? 'Save changes' : `Add ${kind.label} Data Source`}
        </button>
      </div>
    </form>
  );
}

function Field({ label, error, help, children }: { label: string; error?: string; help?: string; children: React.ReactNode }) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      <span className={styles.control}>{children}</span>
      {help && <span className={styles.help}>{help}</span>}
      {error && <span className={styles.error}>{error}</span>}
    </label>
  );
}
