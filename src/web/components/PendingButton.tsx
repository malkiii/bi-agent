'use client';

import { useEffect, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { useBotley } from '@/web/botley/BotleyProvider';

/**
 * A submit button that puts Botley in `thinking` while its form's server action runs.
 * Use it inside a <form action={...}>.
 */
export function PendingButton({ children, className = 'btn' }: { children: ReactNode; className?: string }) {
  const { pending } = useFormStatus();
  const { setBotleyState, settleBotley } = useBotley();
  useEffect(() => {
    if (!pending) return;
    setBotleyState('thinking');
    return () => settleBotley();
  }, [pending, setBotleyState, settleBotley]);
  return (
    <button type="submit" className={className} disabled={pending} aria-busy={pending}>
      {children}
    </button>
  );
}
