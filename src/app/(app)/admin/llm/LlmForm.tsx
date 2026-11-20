'use client';

import { useActionState } from 'react';
import type { LlmSettingsView } from '@/core';
import styles from '@/web/components/DataSourceForm.module.css';
import { saveLlmSettings } from './actions';

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  google: 'Google Gemini',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  ollama: 'Ollama',
};

/** Provider + model picker; the App Core validates the choice and that the actor is an admin. */
export function LlmForm({ settings }: { settings: LlmSettingsView }) {
  const [state, action, pending] = useActionState(saveLlmSettings, {});
  const active = settings.active;
  return (
    <form action={action} className={styles.form}>
      <label className={styles.field}>
        <span className={styles.label}>Provider</span>
        <span className={styles.control}>
          <select name="provider" defaultValue={active?.provider} required className={styles.input}>
            {settings.providers.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p] ?? p}
              </option>
            ))}
          </select>
        </span>
        {state.fieldErrors?.provider && <span className={styles.error}>{state.fieldErrors.provider}</span>}
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Model</span>
        <span className={styles.control}>
          <input name="model" defaultValue={active?.model} required className={styles.input} placeholder="Model ID" />
        </span>
        <span className={styles.help}>The provider&apos;s model ID, e.g. claude-sonnet-4-5 or gpt-5.</span>
        {state.fieldErrors?.model && <span className={styles.error}>{state.fieldErrors.model}</span>}
      </label>

      {state.message && (
        <p role="alert" className={styles.error}>
          {state.message}
        </p>
      )}
      {state.saved && <p className={styles.success}>Saved. New Prompts use this model.</p>}

      <div className={styles.actions}>
        <button type="submit" name="intent" value="save" className="btn" disabled={pending}>
          Save
        </button>
        {settings.overridden && (
          <button type="submit" name="intent" value="reset" formNoValidate className="btn btn--ghost" disabled={pending}>
            Use the default
          </button>
        )}
      </div>
    </form>
  );
}
