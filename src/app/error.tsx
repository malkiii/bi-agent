'use client';

import { ErrorPanel } from '@/web/components/ErrorPanel';

/** Errors outside the app shell (sign-in page, or the shell itself failing to load). */
export default function RootError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="page-narrow">
      <ErrorPanel {...props} />
    </main>
  );
}
