'use client';

import { useActionState, useEffect } from 'react';
import { useBIBot } from '@/web/bibot/BIBotProvider';
import styles from '@/web/reports/reports.module.css';
import { approveKpiAction } from './actions';

/** Approves a draft KPI: checks its Answer is a single number and pins the query. */
export function ApproveKpiButton({ id }: { id: string }) {
  const [state, approve, pending] = useActionState(approveKpiAction, {});
  const { setBIBotState } = useBIBot();

  useEffect(() => {
    if (state.error) setBIBotState('error');
  }, [state, setBIBotState]);

  return (
    <form action={approve} className="actions">
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="btn" disabled={pending}>
        {pending ? 'Approving…' : 'Approve KPI'}
      </button>
      {state.error && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}
