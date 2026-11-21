'use client';

import { useActionState, useEffect } from 'react';
import { KPI_NAME_MAX } from '@/core/kpis/kpi-options';
import { useBotley } from '@/web/botley/BotleyProvider';
import formStyles from '@/web/components/DataSourceForm.module.css';
import { createKpiAction } from './actions';

/** New KPI: a plain-language definition the agent turns into a single-number query to approve. */
export function KpiForm() {
  const [state, save, saving] = useActionState(createKpiAction, {});
  const { setBotleyState } = useBotley();
  const errors = state.fieldErrors ?? {};

  useEffect(() => {
    if (saving) setBotleyState('thinking');
    else if (state.message) setBotleyState('error');
  }, [saving, state, setBotleyState]);

  return (
    <form action={save} className={formStyles.form}>
      <label className={formStyles.field}>
        <span className={formStyles.label}>What should it measure?</span>
        <textarea name="prompt" rows={3} required className={formStyles.input} placeholder="Orders placed yesterday" />
        <span className={formStyles.help}>
          Botley drafts a query that returns one number. You check it, then approve it to pin the query.
        </span>
        {errors.prompt && <span className={formStyles.error}>{errors.prompt}</span>}
      </label>
      <label className={formStyles.field}>
        <span className={formStyles.label}>Name</span>
        <input name="name" className={formStyles.input} placeholder="Defaults to the definition" maxLength={KPI_NAME_MAX} />
      </label>
      {state.message && <p className={formStyles.error}>{state.message}</p>}
      <div className={formStyles.actions}>
        <button type="submit" className="btn" disabled={saving}>
          {saving ? 'Botley is drafting…' : 'Draft KPI'}
        </button>
      </div>
    </form>
  );
}
