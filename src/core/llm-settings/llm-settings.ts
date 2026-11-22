import type { LanguageModel } from 'ai';
import type { Db } from 'mongodb';
import { AppError, ValidationError } from '../errors';
import type { Clock, LanguageModelProvider, LlmChoice, LlmModel } from '../ports';
import type { Users } from '../users/users';
import type { AuditRecorder } from '../audit/audit';

export interface LlmSettingsView {
  /**
   * The provider and model new Prompts use: the admin's choice, else the first configured
   * provider that has a default model; null when neither is available.
   */
  active: LlmChoice | null;
  /** Whether `active` is an admin's choice (false: the default, or nothing). */
  chosen: boolean;
  /** Providers with configured credentials (in `.env`); the only ones an admin may choose. */
  providers: readonly string[];
  /** Each offered provider's display name. */
  labels: Record<string, string>;
}

/**
 * The active LLM provider and model, for web and Slack alike. Stored in the database and read
 * on every Prompt, so a change reaches `web` and `worker` without a restart.
 */
export interface LlmSettings {
  /** Admin only. */
  get(actorSlackUserId: string): Promise<LlmSettingsView>;
  /**
   * Admin only: the chat models `provider` offers, sorted by name. ValidationError when the
   * provider has no configured credentials; ModelListError when the provider can't be reached.
   */
  listModels(actorSlackUserId: string, provider: string): Promise<LlmModel[]>;
  /**
   * Admin only: sets the provider and model new Prompts use. Throws ValidationError when the
   * provider has no configured credentials or the model is empty.
   */
  set(actorSlackUserId: string, choice: LlmChoice): Promise<LlmSettingsView>;
}

/** Resolves the model for a new Prompt (the App Core's view of the active LLM). */
export interface ActiveLanguageModel {
  getModel(): Promise<LanguageModel>;
  /** The provider and model `getModel` builds now; null when none is available. */
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

/** No provider and model are chosen or available by default, so a Prompt cannot be answered. */
export class NoLlmConfiguredError extends AppError {
  constructor() {
    super('no_llm_configured', 'No language model is available yet: an admin can choose one in Admin > Settings.');
  }
}

/** The provider's model list could not be fetched (network, bad key, outage). */
export class ModelListError extends AppError {
  constructor(provider: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super('model_list_failed', `Couldn't load the models from ${provider}: ${reason}`);
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

  /** The stored choice while its provider is still configured, else the first provider (in order) with a default model. */
  async function resolve(): Promise<{ active: LlmChoice | null; chosen: boolean }> {
    const doc = await docs.findOne({ _id: 'llm' });
    const providers = llm.configuredProviders();
    if (doc && providers.includes(doc.provider)) return { active: { provider: doc.provider, model: doc.model }, chosen: true };
    for (const provider of providers) {
      const model = await llm.defaultModel(provider);
      if (model) return { active: { provider, model }, chosen: false };
    }
    return { active: null, chosen: false };
  }

  async function view(): Promise<LlmSettingsView> {
    const providers = llm.configuredProviders();
    return {
      ...(await resolve()),
      providers,
      labels: Object.fromEntries(providers.map((p) => [p, llm.providerLabel(p)])),
    };
  }

  const providerError = () => new ValidationError('Check the LLM settings.', { provider: 'Choose a provider whose API key is configured.' });

  return {
    settings: {
      async get(actor) {
        await users.requireAdmin(actor);
        return view();
      },

      async listModels(actor, provider) {
        await users.requireAdmin(actor);
        if (!llm.configuredProviders().includes(provider)) throw providerError();
        let models: LlmModel[];
        try {
          models = await llm.listModels(provider);
        } catch (error) {
          throw new ModelListError(llm.providerLabel(provider), error);
        }
        return [...models].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      },

      async set(actor, choice) {
        await users.requireAdmin(actor);
        const provider = choice.provider.trim();
        const model = choice.model.trim();
        const fieldErrors: Record<string, string> = {};
        if (!llm.configuredProviders().includes(provider)) {
          fieldErrors.provider = 'Choose a provider whose API key is configured.';
        }
        if (!model) fieldErrors.model = 'Choose a model.';
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
