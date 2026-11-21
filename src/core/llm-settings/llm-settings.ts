import type { LanguageModel } from 'ai';
import type { Db } from 'mongodb';
import { AppError, ValidationError } from '../errors';
import type { Clock, LanguageModelProvider, LlmChoice } from '../ports';
import type { Users } from '../users/users';
import type { AuditRecorder } from '../audit/audit';

export interface LlmSettingsView {
  /** The provider and model new Prompts use; null when none is configured. */
  active: LlmChoice | null;
  /** `admin` once an admin chose, else `environment` (LLM_PROVIDER, LLM_MODEL). */
  source: 'admin' | 'environment' | null;
  /** Providers with configured credentials; the only ones an admin may choose. */
  providers: readonly string[];
}

/**
 * The active LLM provider and model, for web and Slack alike. Stored in the database and read
 * on every Prompt, so a change reaches `web` and `worker` without a restart.
 */
export interface LlmSettings {
  /** Admin only. */
  get(actorSlackUserId: string): Promise<LlmSettingsView>;
  /**
   * Admin only: sets the provider and model new Prompts use. Throws ValidationError when the
   * provider has no configured credentials or the model is empty.
   */
  set(actorSlackUserId: string, choice: LlmChoice): Promise<LlmSettingsView>;
}

/** Resolves the model for a new Prompt (the App Core's view of the active LLM). */
export interface ActiveLanguageModel {
  getModel(): Promise<LanguageModel>;
  /** The provider and model `getModel` builds now; null when none is configured. */
  choice(): Promise<LlmChoice | null>;
}

interface LlmSettingsDoc {
  _id: 'llm';
  provider: string;
  model: string;
  updatedBy: string;
  updatedAt: Date;
}

export const MAX_MODEL_LENGTH = 200;

/** No provider and model are configured, so a Prompt cannot be answered. */
export class NoLlmConfiguredError extends AppError {
  constructor() {
    super('no_llm_configured', 'No LLM is configured: set LLM_PROVIDER and LLM_MODEL, or choose one in admin settings.');
  }
}

export function createLlmSettings({
  db,
  clock,
  users,
  llm,
  audit,
}: {
  db: Db;
  clock: Clock;
  users: Users;
  llm: LanguageModelProvider;
  audit: AuditRecorder;
}): {
  settings: LlmSettings;
  active: ActiveLanguageModel;
} {
  const docs = db.collection<LlmSettingsDoc>('appSettings');

  /** The stored choice while its provider is still configured, else the environment's default. */
  async function resolve(): Promise<Omit<LlmSettingsView, 'providers'>> {
    const doc = await docs.findOne({ _id: 'llm' });
    if (doc && llm.configuredProviders().includes(doc.provider)) {
      return { active: { provider: doc.provider, model: doc.model }, source: 'admin' };
    }
    const fallback = llm.defaultChoice();
    return fallback ? { active: fallback, source: 'environment' } : { active: null, source: null };
  }

  async function view(): Promise<LlmSettingsView> {
    return { ...(await resolve()), providers: llm.configuredProviders() };
  }

  return {
    settings: {
      async get(actor) {
        await users.requireAdmin(actor);
        return view();
      },

      async set(actor, choice) {
        await users.requireAdmin(actor);
        const provider = choice.provider.trim();
        const model = choice.model.trim();
        const fieldErrors: Record<string, string> = {};
        if (!llm.configuredProviders().includes(provider)) {
          fieldErrors.provider = 'Choose a provider whose API key is configured.';
        }
        if (!model) fieldErrors.model = 'Enter a model.';
        else if (model.length > MAX_MODEL_LENGTH) fieldErrors.model = `Keep the model under ${MAX_MODEL_LENGTH} characters.`;
        if (Object.keys(fieldErrors).length > 0) throw new ValidationError('Check the LLM settings.', fieldErrors);

        await docs.updateOne(
          { _id: 'llm' },
          { $set: { provider, model, updatedBy: actor, updatedAt: clock.now() } },
          { upsert: true },
        );
        await audit.record({ actor, type: 'llm_settings', action: 'changed', details: { provider, model } });
        return view();
      },
    },
    active: {
      async getModel() {
        const { active } = await resolve();
        if (!active) throw new NoLlmConfiguredError();
        return llm.getModel(active);
      },
      async choice() {
        return (await resolve()).active;
      },
    },
  };
}
