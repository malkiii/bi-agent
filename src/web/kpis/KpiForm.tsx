'use client';

import { useActionState, useEffect } from 'react';
import { KPI_NAME_MAX } from '@/core/kpis/kpi-options';
import { useBIBot } from '@/web/bibot/BIBotProvider';
import formStyles from '@/web/components/DataSourceForm.module.css';
import { createKpiAction } from './actions';

/** New KPI: a plain-language definition the agent turns into a single-number query to approve. */
export function KpiForm() {
  const [state, save, saving] = useActionState(createKpiAction, {});
  const { setBIBotState } = useBIBot();
  const errors = state.fieldErrors ?? {};

  useEffect(() => {
    if (saving) setBIBotState('thinking');
    else if (state.message) setBIBotState('error');
  }, [saving, state, setBIBotState]);

  return (
    <form action={save} className={formStyles.form}>
      <label className={formStyles.field}>
        <span className={formStyles.label}>What should it measure?</span>
        <textarea name="prompt" rows={3} required className={formStyles.input} placeholder="Orders placed yesterday" />
        <span className={formStyles.help}>
          BIBot drafts a query that returns one number. You check it, then approve it to pin the query.
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
          {saving ? 'BIBot is drafting…' : 'Draft KPI'}
        </button>
      </div>
    </form>
  );
}
