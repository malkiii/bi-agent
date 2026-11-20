import type { ThemePreference } from '@/core';

/** The theme actually on screen for a preference, given the browser's prefers-color-scheme. */
export function effectiveTheme(preference: ThemePreference, systemPrefersDark: boolean): 'light' | 'dark' {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

/** The toggle always switches to the opposite of what's on screen and saves it explicitly. */
export function toggledTheme(preference: ThemePreference, systemPrefersDark: boolean): 'light' | 'dark' {
  return effectiveTheme(preference, systemPrefersDark) === 'dark' ? 'light' : 'dark';
}

/** `data-theme` on <html>: absent for `system`, so the prefers-color-scheme media query applies. */
export function themeAttribute(preference: ThemePreference): 'light' | 'dark' | undefined {
  return preference === 'system' ? undefined : preference;
}
