'use client';

import { useActionState, useEffect } from 'react';
import { useBIBot } from '@/web/bibot/BIBotProvider';
import { approveReportAction } from './actions';
import styles from './reports.module.css';

/** Approves a draft Report (or re-approves a failed one): pins its queries and layout and starts its schedule. */
export function ApproveButton({ id, reapprove = false }: { id: string; reapprove?: boolean }) {
  const [state, approve, pending] = useActionState(approveReportAction, {});
  const { setBIBotState } = useBIBot();

  useEffect(() => {
    if (state.error) setBIBotState('error');
  }, [state, setBIBotState]);

  return (
    <form action={approve} className="actions">
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="btn" disabled={pending}>
        {pending ? 'Approving…' : reapprove ? 'Re-approve and resume' : 'Approve and schedule'}
      </button>
      {state.error && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}
