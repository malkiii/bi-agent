'use client';

import { useActionState } from 'react';
import formStyles from '@/web/components/DataSourceForm.module.css';
import { refreshKpiAction } from './actions';

/** Re-runs the KPI's Pinned Query to show its value as of now. */
export function RefreshKpiButton({ id }: { id: string }) {
  const [state, refresh, pending] = useActionState(refreshKpiAction, {});
  return (
    <form action={refresh} className="actions">
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="btn btn--ghost" disabled={pending}>
        {pending ? 'Refreshing…' : 'Refresh'}
      </button>
      {state.error && (
        <span className={formStyles.error} role="alert">
          {state.error}
        </span>
      )}
    </form>
  );
}
