'use server';

import type { ThemePreference } from '@/core';
import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';

/** Saves the signed-in user's theme. The App Core rejects anything but light/dark/system. */
export async function saveThemePreference(theme: ThemePreference): Promise<void> {
  const user = await requireUser();
  await (await getCore()).preferences.setTheme(user.slackUserId, theme);
}
