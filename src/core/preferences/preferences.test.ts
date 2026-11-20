import { afterEach, beforeEach, expect, test } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing';

let h: TestHarness;
beforeEach(async () => {
  h = await createTestHarness();
});
afterEach(() => h.close());

test('a user who never chose a theme follows the system setting', async () => {
  expect(await h.core.preferences.getTheme('U1')).toBe('system');
});

test('a chosen theme is remembered for that user only', async () => {
  await h.core.preferences.setTheme('U1', 'dark');
  await h.core.preferences.setTheme('U2', 'light');
  await h.core.preferences.setTheme('U1', 'light');
  await h.core.preferences.setTheme('U1', 'dark');

  expect(await h.core.preferences.getTheme('U1')).toBe('dark');
  expect(await h.core.preferences.getTheme('U2')).toBe('light');
  expect(await h.core.preferences.getTheme('U3')).toBe('system');
});

test('an unknown theme is refused and the saved one is kept', async () => {
  await h.core.preferences.setTheme('U1', 'dark');

  await expect(h.core.preferences.setTheme('U1', 'neon' as never)).rejects.toMatchObject({ code: 'invalid_theme' });
  expect(await h.core.preferences.getTheme('U1')).toBe('dark');
});
