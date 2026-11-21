'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useBotley } from '@/web/botley/BotleyProvider';
import { SaveQuestionButton } from '@/web/saved-questions/SaveQuestionButton';
import { AnswerView } from './AnswerView';
import type { ChatItem } from './items';
import { DataSourcePicker, type DataSourceOption } from './DataSourcePicker';
import { createNdjsonParser, type ChatRequest, type ChatStreamEvent } from './wire';
import styles from './chat.module.css';

/**
 * The web chat: the Conversation so far plus the prompt box. Sends each Prompt to
 * POST /api/chat and renders the streamed Answer as it arrives. `readOnly` shows the
 * messages only (Slack Conversations, which continue in Slack or in a Fork). With
 * `dataSources`, a picker locks the Conversation to some of them (sent with each Prompt).
 * `openAfterAnswer` (the dashboard home) moves to the Conversation's own page once the first
 * Answer has streamed in, so it continues there.
 */
export function ChatView({
  conversationId: initialId,
  initialItems,
  readOnly = false,
  dataSources = [],
  lockedDataSourceIds = [],
  openAfterAnswer = false,
}: {
  conversationId?: string;
  initialItems: ChatItem[];
  readOnly?: boolean;
  /** Data Sources the agent can query, to lock the Conversation to. */
  dataSources?: DataSourceOption[];
  lockedDataSourceIds?: string[];
  openAfterAnswer?: boolean;
}) {
  const [conversationId, setConversationId] = useState(initialId);
  const [items, setItems] = useState<ChatItem[]>(initialItems);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  // Locked Data Sources that were deleted since are dropped, so the next Prompt sends a lock that still works.
  const [locked, setLocked] = useState(() => lockedDataSourceIds.filter((id) => dataSources.some((ds) => ds.id === id)));
  const seq = useRef(0);
  const { setBotleyState, settleBotley } = useBotley();
  const router = useRouter();

  async function ask(text: string) {
    const answerId = `live-${++seq.current}`;
    const update = (change: (a: Extract<ChatItem, { kind: 'answer' }>) => Partial<ChatItem>) =>
      setItems((list) =>
        list.map((item) => (item.id === answerId && item.kind === 'answer' ? ({ ...item, ...change(item) } as ChatItem) : item)),
      );
    setItems((list) => [
      ...list,
      { kind: 'prompt', id: `prompt-${seq.current}`, text },
      { kind: 'answer', id: answerId, status: 'pending', blocks: [], sources: [], queries: [] },
    ]);
    setBusy(true);
    setBotleyState('thinking');

    let failed = false;
    let startedId: string | undefined;
    const onEvent = (event: ChatStreamEvent) => {
      switch (event.type) {
        case 'conversation':
          if (event.id !== conversationId) {
            startedId = event.id;
            setConversationId(event.id);
            window.history.replaceState(null, '', `/chat/${event.id}`);
          }
          break;
        case 'progress':
          update(() => ({ progress: event.label }));
          break;
        case 'query':
          update((a) => ({ queries: [...a.queries, event.query] }));
          break;
        case 'block':
          update((a) => ({ blocks: [...a.blocks, event.block] }));
          break;
        case 'answer':
          failed = event.answer.status === 'failed';
          update(() => ({ ...event.answer, messageId: event.messageId, progress: undefined }));
          break;
        case 'error':
          failed = true;
          update(() => ({ status: 'failed', error: event.message }));
          break;
      }
    };

    try {
      const body: ChatRequest = { conversationId, prompt: text, dataSourceIds: locked };
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        const message = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
        onEvent({ type: 'error', message: message ?? 'Botley could not be reached. Try again.' });
      } else {
        const parser = createNdjsonParser(onEvent);
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.push(value);
        }
        parser.end();
      }
    } catch {
      onEvent({ type: 'error', message: 'The connection dropped. Reload the page to see whether the Answer was saved.' });
    } finally {
      setItems((list) =>
        list.map((item) =>
          item.id === answerId && item.kind === 'answer' && item.status === 'pending'
            ? { ...item, status: 'failed', error: 'The Answer was interrupted.' }
            : item,
        ),
      );
      setBusy(false);
      if (failed) setBotleyState('error');
      else settleBotley();
      if (openAfterAnswer && startedId) router.push(`/chat/${startedId}`);
    }
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = prompt.trim();
    if (!text || busy) return;
    setPrompt('');
    void ask(text);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) submit(event);
  }

  const empty = items.length === 0;
  return (
    <div className={styles.chat}>
      {!empty && (
        <ol className={styles.messages} aria-live="polite">
          {items.map((item) =>
            item.kind === 'prompt' ? (
              <li key={item.id} className={styles.prompt}>
                <p>{item.text}</p>
              </li>
            ) : (
              <li key={item.id}>
                <AnswerView {...item} />
                {!readOnly && conversationId && item.messageId && item.status === 'complete' && item.queries.some((q) => q.ok) && (
                  <SaveQuestionButton conversationId={conversationId} answerMessageId={item.messageId} />
                )}
              </li>
            ),
          )}
        </ol>
      )}
      {!readOnly && dataSources.length > 1 && (
        <DataSourcePicker options={dataSources} selected={locked} onChange={setLocked} disabled={busy} />
      )}
      {!readOnly && (
        <form className={`${styles.promptBox} ${empty ? styles.promptBoxBig : ''}`} onSubmit={submit}>
          <label htmlFor="prompt" className={styles.srOnly}>
            Your question
          </label>
          <textarea
            id="prompt"
            name="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={empty ? 'Ask Botley about your data, e.g. "How many orders did we ship last week by region?"' : 'Ask a follow-up…'}
            rows={empty ? 4 : 2}
            maxLength={8000}
            disabled={busy}
          />
          <button type="submit" className="btn" disabled={busy || !prompt.trim()}>
            {busy ? 'Answering…' : 'Ask'}
          </button>
        </form>
      )}
    </div>
  );
}
