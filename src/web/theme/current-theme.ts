import { unstable_rethrow } from 'next/navigation';
import type { ThemePreference } from '@/core';
import { getCurrentUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';

/**
 * The signed-in user's saved theme, or `system` when signed out or the database is unreachable
 * (the page must still render, e.g. the sign-in page or an error page).
 */
export async function getThemePreference(): Promise<ThemePreference> {
  try {
    const user = await getCurrentUser();
    if (!user) return 'system';
    return await (await getCore()).preferences.getTheme(user.slackUserId);
  } catch (error) {
    unstable_rethrow(error); // let Next's own control-flow errors (dynamic rendering, redirects) through
    return 'system';
  }
}
