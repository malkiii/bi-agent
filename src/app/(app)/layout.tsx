import type { ReactNode } from 'react';
import { AppShell } from '@/web/components/AppShell';
import { requireUser } from '@/web/current-user';

/** Every page in the (app) group is signed-in only and rendered inside the app shell. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return (
    <AppShell user={user}>
      {children}
    </AppShell>
  );
}
