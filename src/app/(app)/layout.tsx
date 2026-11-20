import type { ReactNode } from 'react';
import { AppShell } from '@/web/components/AppShell';
import { requireUser } from '@/web/current-user';
import { getThemePreference } from '@/web/theme/current-theme';

/** Every page in the (app) group is signed-in only and rendered inside the app shell. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const [user, theme] = await Promise.all([requireUser(), getThemePreference()]);
  return (
    <AppShell user={user} theme={theme}>
      {children}
    </AppShell>
  );
}
