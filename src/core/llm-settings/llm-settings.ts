import type { LanguageModel } from 'ai';
import type { Db } from 'mongodb';
import { AppError, ValidationError } from '../errors';
import type { Clock, LanguageModelProvider, LlmChoice, LlmModel } from '../ports';
import type { Users } from '../users/users';
import type { AuditRecorder } from '../audit/audit';

export interface LlmSettingsView {
  /** The provider and model new Prompts use; null until an admin chooses one. */
  active: LlmChoice | null;
  /** Providers with configured credentials; the only ones an admin may choose. */
  providers: readonly string[];
  /** The provider to pre-select when nothing is chosen yet (LLM_PROVIDER); null when unset. */
  defaultProvider: string | null;
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
  /** The provider and model `getModel` builds now; null when none is chosen. */
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

/** No provider and model are chosen, so a Prompt cannot be answered. */
export class NoLlmConfiguredError extends AppError {
  constructor() {
    super('no_llm_configured', 'No language model is chosen yet: an admin can choose one in Admin > Settings.');
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

  /** The stored choice while its provider is still configured. */
  async function resolve(): Promise<LlmChoice | null> {
    const doc = await docs.findOne({ _id: 'llm' });
    return doc && llm.configuredProviders().includes(doc.provider) ? { provider: doc.provider, model: doc.model } : null;
  }

  async function view(): Promise<LlmSettingsView> {
    const providers = llm.configuredProviders();
    const defaultProvider = llm.defaultProvider();
    return {
      active: await resolve(),
      providers,
      defaultProvider: defaultProvider && providers.includes(defaultProvider) ? defaultProvider : null,
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
          throw new ModelListError(provider, error);
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
        const active = await resolve();
        if (!active) throw new NoLlmConfiguredError();
        return llm.getModel(active);
      },
      async choice() {
        return resolve();
      },
    },
  };
}
