import type { Db } from 'mongodb';
import { ValidationError } from '../errors';
import type { Clock, LanguageModelProvider, LlmChoice } from '../ports';
import type { Users } from '../users/users';

export interface LlmSettingsView {
  /** Providers whose credentials are configured in the environment. */
  providers: readonly string[];
  /** The environment's LLM_PROVIDER / LLM_MODEL, or null when unset. */
  default: LlmChoice | null;
  /** What new Prompts use. */
  active: LlmChoice | null;
  /** True when an admin's choice replaces the default. */
  overridden: boolean;
}

/**
 * The active LLM provider and model. The environment holds the default; admins may override
 * it among the configured providers. The override lives in Mongo and is read on every Prompt,
 * so web and worker pick up a change without a restart.
 */
export interface LlmSettings {
  /** Admin only. */
  get(actorSlackUserId: string): Promise<LlmSettingsView>;
  /** Admin only. Throws ValidationError for an unconfigured provider or an empty model. */
  set(actorSlackUserId: string, choice: LlmChoice): Promise<LlmSettingsView>;
  /** Admin only: drops the override, so the environment default applies again. */
  reset(actorSlackUserId: string): Promise<LlmSettingsView>;
  /** The choice new Prompts use (no access check: internal to the agent loop). */
  active(): Promise<LlmChoice | null>;
}

interface LlmSettingsDoc {
  _id: 'llm';
  provider: string;
  model: string;
  updatedAt: Date;
  updatedBy: string;
}

export function createLlmSettings({
  db,
  clock,
  users,
  llm,
}: {
  db: Db;
  clock: Clock;
  users: Users;
  llm: LanguageModelProvider;
}): LlmSettings {
  const settings = db.collection<LlmSettingsDoc>('settings');
  const options = () => llm.options?.() ?? { default: null, providers: [] };

  async function view(): Promise<LlmSettingsView> {
    const { default: fallback, providers } = options();
    const doc = await settings.findOne({ _id: 'llm' });
    // An override whose provider lost its key falls back to the default.
    const override = doc && providers.includes(doc.provider) ? { provider: doc.provider, model: doc.model } : null;
    return { providers, default: fallback, active: override ?? fallback, overridden: override !== null };
  }

  return {
    async get(actor) {
      await users.requireAdmin(actor);
      return view();
    },

    async set(actor, choice) {
      await users.requireAdmin(actor);
      const provider = typeof choice?.provider === 'string' ? choice.provider.trim() : '';
      const model = typeof choice?.model === 'string' ? choice.model.trim() : '';
      const fieldErrors: Record<string, string> = {};
      if (!options().providers.includes(provider)) fieldErrors.provider = 'Choose a provider whose key is configured.';
      if (!model) fieldErrors.model = 'Enter a model ID.';
      if (Object.keys(fieldErrors).length) throw new ValidationError('Check the LLM settings.', fieldErrors);
      await settings.updateOne(
        { _id: 'llm' },
        { $set: { provider, model, updatedAt: clock.now(), updatedBy: actor } },
        { upsert: true },
      );
      return view();
    },

    async reset(actor) {
      await users.requireAdmin(actor);
      await settings.deleteOne({ _id: 'llm' });
      return view();
    },

    async active() {
      return (await view()).active;
    },
  };
}

/** The agent loop's model source: resolves the active choice on every call. */
export function withActiveChoice(llm: LanguageModelProvider, settings: LlmSettings): LanguageModelProvider {
  return {
    async getModel() {
      return llm.getModel((await settings.active()) ?? undefined);
    },
    options: llm.options && (() => llm.options!()),
  };
}
