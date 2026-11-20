'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import type { SavedQuestionVisibility } from '@/core';
import { useBotley } from '@/web/botley/BotleyProvider';
import { saveQuestionAction } from './actions';
import styles from './questions.module.css';

/** "Save" under an Answer: pins its queries and layout as a Saved Question. */
export function SaveQuestionButton({ conversationId, answerMessageId }: { conversationId: string; answerMessageId: string }) {
  const [visibility, setVisibility] = useState<SavedQuestionVisibility>('private');
  const [savedId, setSavedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { setBotleyState } = useBotley();

  if (savedId) {
    return (
      <p className={styles.saveBar}>
        Saved. <Link href={`/questions/${savedId}`}>Open the Saved Question</Link>
      </p>
    );
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveQuestionAction({ conversationId, answerMessageId, visibility });
      if (result.ok) {
        setSavedId(result.id);
        setBotleyState('success');
      } else {
        setError(result.error);
        setBotleyState('error');
      }
    });
  }

  return (
    <div className={styles.saveBar}>
      <button type="button" className="btn btn--ghost" onClick={save} disabled={pending}>
        {pending ? 'Saving…' : 'Save question'}
      </button>
      <label>
        <input
          type="checkbox"
          checked={visibility === 'shared'}
          onChange={(e) => setVisibility(e.target.checked ? 'shared' : 'private')}
        />{' '}
        Share with everyone
      </label>
      {error && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
