'use client';

import { useActionState } from 'react';
import type { Role } from '@/core';
import { setRoleAction } from './actions';
import styles from './users.module.css';

/** Promote/demote button for one user, with the App Core's refusal shown inline. */
export function RoleForm({ slackUserId, role, isSelf }: { slackUserId: string; role: Role; isSelf: boolean }) {
  const [state, action, pending] = useActionState(setRoleAction, { error: null });
  const next: Role = role === 'admin' ? 'member' : 'admin';
  const label = role === 'admin' ? (isSelf ? 'Step down' : 'Demote to member') : 'Promote to admin';
  return (
    <form action={action} className={styles.roleForm}>
      <input type="hidden" name="slackUserId" value={slackUserId} />
      <input type="hidden" name="role" value={next} />
      <button type="submit" className={role === 'admin' ? 'btn btn--ghost' : 'btn'} disabled={pending}>
        {label}
      </button>
      {state.error && (
        <span role="alert" className={styles.error}>
          {state.error}
        </span>
      )}
    </form>
  );
}
