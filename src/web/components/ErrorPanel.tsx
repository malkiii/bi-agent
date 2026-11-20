'use client';

import Link from 'next/link';
import { Botley } from './Botley';

/** Body of the error boundaries (`error.tsx`): Botley in `error`, a retry and a way home. */
export function ErrorPanel({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="card" role="alert">
      <Botley rest="error" size={120} />
      <h1>Something went wrong</h1>
      <p>Botley tripped over a wire. Try again, and if it keeps happening tell an admin.</p>
      {error.digest && (
        <p>
          <code>ref: {error.digest}</code>
        </p>
      )}
      <p className="actions">
        <button type="button" className="btn" onClick={reset}>
          Try again
        </button>
        <Link href="/" className="btn btn--ghost">
          Back home
        </Link>
      </p>
    </section>
  );
}
