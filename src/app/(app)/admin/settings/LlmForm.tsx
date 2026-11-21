'use client';

import { useActionState, useRef, useState } from 'react';
import type { LlmChoice, LlmModel } from '@/core';
import { listLlmModels, saveLlmSettings, type ModelListResult } from './actions';
import styles from '@/web/components/DataSourceForm.module.css';

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  ollama: 'Ollama',
};

export const providerLabel = (provider: string) => PROVIDER_LABELS[provider] ?? provider;

/** The select's value for "type the id by hand". */
const CUSTOM = '\u0000custom';

type ModelList = { status: 'loading' } | { status: 'ok'; models: LlmModel[] } | { status: 'error'; error: string };

const toList = (result: ModelListResult): ModelList =>
  'models' in result ? { status: 'ok', models: result.models } : { status: 'error', error: result.error };

/** A saved model the provider doesn't list (any more) is shown as a typed id rather than lost. */
const unlisted = (list: ModelList, model: string) => list.status === 'ok' && !!model && !list.models.some((m) => m.id === model);

/**
 * Provider and model picker. Only providers with configured credentials are offered; the
 * model list is fetched from the chosen provider, with a typed model id as the fallback.
 * The page loads the first provider's list; changing provider loads that one's.
 */
export function LlmForm({
  providers,
  active,
  initialProvider,
  initialModels,
}: {
  providers: readonly string[];
  active: LlmChoice | null;
  initialProvider: string;
  initialModels: ModelListResult;
}) {
  const [state, save, saving] = useActionState(saveLlmSettings, {});
  // Controlled: React resets uncontrolled forms after an action.
  const [provider, setProvider] = useState(initialProvider);
  const [model, setModel] = useState(initialProvider === active?.provider ? active.model : '');
  const [list, setList] = useState<ModelList>(() => toList(initialModels));
  const [custom, setCustom] = useState(() => unlisted(toList(initialModels), model));
  /** Only the latest request may update the list. */
  const request = useRef(0);

  async function load(nextProvider: string, keepModel: string) {
    const id = ++request.current;
    setList({ status: 'loading' });
    const result = await listLlmModels(nextProvider).catch((): ModelListResult => ({ error: 'Could not load the models.' }));
    if (id !== request.current) return;
    const next = toList(result);
    setList(next);
    setCustom(unlisted(next, keepModel));
  }

  const models = list.status === 'ok' ? list.models : [];
  // Type the id when asked to, or when the list failed or came back empty.
  const typing = custom || list.status === 'error' || (list.status === 'ok' && models.length === 0);

  function chooseProvider(next: string) {
    const keep = next === active?.provider ? active.model : '';
    setProvider(next);
    setModel(keep);
    setCustom(false);
    void load(next, keep);
  }

  function chooseFromList(value: string) {
    if (value === CUSTOM) {
      setCustom(true);
    } else {
      setCustom(false);
      setModel(value);
    }
  }

  return (
    <form action={save} className={styles.form}>
      <label className={styles.field}>
        <span className={styles.label}>Provider</span>
        <span className={styles.control}>
          <select name="provider" value={provider} onChange={(e) => chooseProvider(e.target.value)} className={styles.input}>
            {providers.map((p) => (
              <option key={p} value={p}>
                {providerLabel(p)}
              </option>
            ))}
          </select>
        </span>
        {state.fieldErrors?.provider && <span className={styles.error}>{state.fieldErrors.provider}</span>}
      </label>

      <label className={styles.field}>
        <span className={styles.label}>Model</span>
        <span className={styles.control}>
          <select
            value={typing ? CUSTOM : model}
            onChange={(e) => chooseFromList(e.target.value)}
            disabled={list.status === 'loading'}
            required={!typing}
            className={styles.input}
          >
            {list.status === 'loading' && <option value={model}>Loading models…</option>}
            {list.status === 'ok' && !typing && !model && (
              <option value="" disabled>
                Choose a model
              </option>
            )}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name === m.id ? m.id : `${m.name} (${m.id})`}
              </option>
            ))}
            {list.status !== 'loading' && <option value={CUSTOM}>Enter a model id…</option>}
          </select>
        </span>
        {list.status === 'error' && (
          <span className={styles.error}>
            {list.error}{' '}
            <button type="button" className="btn btn--ghost" onClick={() => void load(provider, model)}>
              Try again
            </button>
          </span>
        )}
      </label>

      {typing ? (
        <label className={styles.field}>
          <span className={styles.label}>Model id</span>
          <span className={styles.control}>
            <input
              name="model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              required
              autoComplete="off"
              spellCheck={false}
              className={styles.input}
            />
          </span>
          <span className={styles.help}>The provider&apos;s model id, e.g. claude-sonnet-5-5 or gpt-5.</span>
          {state.fieldErrors?.model && <span className={styles.error}>{state.fieldErrors.model}</span>}
        </label>
      ) : (
        <>
          <input type="hidden" name="model" value={model} />
          {state.fieldErrors?.model && <p className={styles.error}>{state.fieldErrors.model}</p>}
        </>
      )}

      {state.message && <p className={styles.error}>{state.message}</p>}
      {state.saved && !saving && <p className={styles.success}>Saved. New Prompts in web and Slack use this model.</p>}

      <div className={styles.actions}>
        <button type="submit" className="btn" disabled={saving || list.status === 'loading'}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
