'use client';

import { useState, useTransition } from 'react';
import { useBotley } from '@/web/botley/BotleyProvider';
import { BlockView } from '@/web/chat/AnswerView';
import chat from '@/web/chat/chat.module.css';
import { runSavedQuestionAction, type RunResult } from './actions';
import styles from './questions.module.css';

/** One-click re-run of a Saved Question: executes its Pinned Queries and shows the rebuilt blocks. */
export function RunView({ id }: { id: string }) {
  const [result, setResult] = useState<RunResult | null>(null);
  const [pending, startTransition] = useTransition();
  const { setBotleyState, settleBotley } = useBotley();

  function run() {
    setBotleyState('thinking');
    startTransition(async () => {
      const next = await runSavedQuestionAction(id).catch(
        (): RunResult => ({ ok: false, error: 'The re-run could not be started. Try again.' }),
      );
      setResult(next);
      if (next.ok && next.status === 'complete') settleBotley();
      else setBotleyState('error');
    });
  }

  return (
    <section className={styles.run}>
      <p className="actions">
        <button type="button" className="btn" onClick={run} disabled={pending}>
          {pending ? 'Running…' : result ? 'Run again' : 'Run'}
        </button>
        {result?.ok && (
          <span className={chat.muted}>
            Ran at <time dateTime={result.finishedAt}>{result.finishedAt.slice(0, 19).replace('T', ' ')}</time> UTC
          </span>
        )}
      </p>
      {result && !result.ok && (
        <p className={styles.error} role="alert">
          {result.error}
        </p>
      )}
      {result?.ok && (
        <article className={`card ${chat.answer}`}>
          {result.status === 'failed' && (
            <p className={styles.error} role="alert">
              {result.error}
            </p>
          )}
          {result.blocks.map((b, i) =>
            b.status === 'ok' ? (
              <BlockView key={i} block={b.block} />
            ) : (
              <p key={i} className={styles.error} role="alert">
                {b.error}
              </p>
            ),
          )}
          <p className={chat.muted}>Tables are fresh. Text is from when the question was saved.</p>
        </article>
      )}
    </section>
  );
}
