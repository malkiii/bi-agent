'use client';

import { useActionState } from 'react';
import { KPI_NAME_MAX } from '@/core/kpis/kpi-options';
import formStyles from '@/web/components/DataSourceForm.module.css';
import styles from '@/web/reports/reports.module.css';
import { renameKpiAction } from './actions';

/** Renames a KPI in place. */
export function RenameKpiForm({ id, name }: { id: string; name: string }) {
  const [state, rename, pending] = useActionState(renameKpiAction, {});
  return (
    <form action={rename} className={styles.row}>
      <input type="hidden" name="id" value={id} />
      <input name="name" defaultValue={name} required maxLength={KPI_NAME_MAX} className={formStyles.input} aria-label="KPI name" />
      <button type="submit" className="btn btn--ghost" disabled={pending}>
        {pending ? 'Saving…' : 'Rename'}
      </button>
      {state.message && <span className={formStyles.error}>{state.message}</span>}
    </form>
  );
}
