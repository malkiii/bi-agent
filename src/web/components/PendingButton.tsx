'use client';

import { useEffect, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { useBIBot } from '@/web/bibot/BIBotProvider';

/**
 * A submit button that puts BIBot in `thinking` while its form's server action runs.
 * Use it inside a <form action={...}>.
 */
export function PendingButton({ children, className = 'btn' }: { children: ReactNode; className?: string }) {
  const { pending } = useFormStatus();
  const { setBIBotState, settleBIBot } = useBIBot();
  useEffect(() => {
    if (!pending) return;
    setBIBotState('thinking');
    return () => settleBIBot();
  }, [pending, setBIBotState, settleBIBot]);
  return (
    <button type="submit" className={className} disabled={pending} aria-busy={pending}>
      {children}
    </button>
  );
}
