import type { Db } from 'mongodb';
import { AppError } from '../errors';

/** `system` follows the browser's prefers-color-scheme. */
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference);
}

/** Per-user UI preferences. Stored apart from `users` so profile/role changes never touch them. */
export interface Preferences {
  /** The user's saved theme, or `system` if they never chose one. */
  getTheme(slackUserId: string): Promise<ThemePreference>;
  /** Saves the user's theme. Throws AppError `invalid_theme` for anything but light/dark/system. */
  setTheme(slackUserId: string, theme: ThemePreference): Promise<void>;
}

interface UserPreferencesDoc {
  slackUserId: string;
  theme?: ThemePreference;
}

export function createPreferences({ db }: { db: Db }): Preferences {
  const prefs = db.collection<UserPreferencesDoc>('userPreferences');
  return {
    async getTheme(slackUserId) {
      const doc = await prefs.findOne({ slackUserId });
      return doc?.theme ?? 'system';
    },

    async setTheme(slackUserId, theme) {
      if (!isThemePreference(theme)) throw new AppError('invalid_theme', 'Theme must be light, dark or system.');
      await prefs.updateOne({ slackUserId }, { $set: { theme } }, { upsert: true });
    },
  };
}

export async function ensurePreferenceIndexes(db: Db) {
  await db.collection('userPreferences').createIndex({ slackUserId: 1 }, { unique: true });
}
