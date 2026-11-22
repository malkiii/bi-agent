import type { ReactNode } from 'react';

/** Remounts on every navigation, so each page fades up into place. */
export default function AppTemplate({ children }: { children: ReactNode }) {
  return <div className="rise">{children}</div>;
}
