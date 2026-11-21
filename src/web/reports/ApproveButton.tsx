'use client';

import { useActionState, useEffect } from 'react';
import { useBotley } from '@/web/botley/BotleyProvider';
import { approveReportAction } from './actions';
import styles from './reports.module.css';

/** Approves a draft Report: pins its queries and layout and starts its schedule. */
export function ApproveButton({ id }: { id: string }) {
  const [state, approve, pending] = useActionState(approveReportAction, {});
  const { setBotleyState } = useBotley();

  useEffect(() => {
    if (state.error) setBotleyState('error');
  }, [state, setBotleyState]);

  return (
    <form action={approve} className="actions">
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="btn" disabled={pending}>
        {pending ? 'Approving…' : 'Approve and schedule'}
      </button>
      {state.error && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}
