'use client';

import { ErrorPanel } from '@/web/components/ErrorPanel';

/** Errors in signed-in pages render inside the app shell. */
export default function AppError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorPanel {...props} />;
}
