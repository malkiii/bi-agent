'use client';

import { useState, useTransition } from 'react';
import type { ThemePreference } from '@/core';
import { saveThemePreference } from './actions';
import { themeAttribute, toggledTheme } from './theme';

function systemPrefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Light/dark switch in the app header. Applies instantly, then saves the choice for this user. */
export function ThemeToggle({ initial }: { initial: ThemePreference }) {
  const [preference, setPreference] = useState(initial);
  const [, startTransition] = useTransition();

  function toggle() {
    const next = toggledTheme(preference, systemPrefersDark());
    setPreference(next);
    const attr = themeAttribute(next);
    if (attr) document.documentElement.dataset.theme = attr;
    startTransition(() => saveThemePreference(next));
  }

  // The server can't know the system theme, so `system` gets its own label until the user picks one.
  const dark = preference === 'dark';
  return (
    <button
      type="button"
      className="btn btn--ghost"
      onClick={toggle}
      aria-label="Toggle dark mode"
      aria-pressed={preference === 'system' ? undefined : dark}
      title="Toggle dark mode"
    >
      <span aria-hidden="true">{preference === 'system' ? '◐' : dark ? '☾' : '☀'}</span>
      <span>{preference === 'system' ? 'Auto' : dark ? 'Dark' : 'Light'}</span>
    </button>
  );
}
