import { expect, test } from 'vitest';
import { toggledTheme } from './theme';

test('toggling switches to the opposite of what is on screen', () => {
  expect(toggledTheme('light', true)).toBe('dark');
  expect(toggledTheme('dark', false)).toBe('light');
  expect(toggledTheme('system', true)).toBe('light');
  expect(toggledTheme('system', false)).toBe('dark');
});
