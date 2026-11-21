'use client';

import { useActionState, useState } from 'react';
import type { LlmChoice } from '@/core';
import { saveLlmSettings } from './actions';
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

/** Provider and model picker. Only providers with configured credentials are offered. */
export function LlmForm({ providers, active }: { providers: readonly string[]; active: LlmChoice | null }) {
  const [state, save, saving] = useActionState(saveLlmSettings, {});
  // Controlled: React resets uncontrolled forms after an action.
  const [provider, setProvider] = useState(active?.provider ?? providers[0] ?? '');
  const [model, setModel] = useState(active?.model ?? '');

  return (
    <form action={save} className={styles.form}>
      <label className={styles.field}>
        <span className={styles.label}>Provider</span>
        <span className={styles.control}>
          <select name="provider" value={provider} onChange={(e) => setProvider(e.target.value)} className={styles.input}>
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

      {state.message && <p className={styles.error}>{state.message}</p>}
      {state.saved && !saving && <p className={styles.success}>Saved. New Prompts in web and Slack use this model.</p>}

      <div className={styles.actions}>
        <button type="submit" className="btn" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
