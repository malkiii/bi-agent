import type { AnswerSource, ConversationMessage, ExecutedQuery, ResultBlock } from '@/core';

/** What the chat view renders: a Prompt, or an Answer (finished or still streaming). */
export type ChatItem =
  | { kind: 'prompt'; id: string; text: string }
  | {
      kind: 'answer';
      id: string;
      /** The stored Answer message id, once known (for block downloads). */
      messageId?: string;
      status: 'complete' | 'failed' | 'pending';
      error?: string;
      progress?: string;
      blocks: ResultBlock[];
      sources: AnswerSource[];
      queries: ExecutedQuery[];
    };

/** Stored Conversation messages as chat items (plain data, safe to pass to the client). */
export function toChatItems(messages: ConversationMessage[]): ChatItem[] {
  return messages.map((m) =>
    m.kind === 'prompt'
      ? { kind: 'prompt', id: m.id, text: m.text }
      : {
          kind: 'answer',
          id: m.id,
          messageId: m.id,
          status: m.answer.status,
          ...(m.answer.error ? { error: m.answer.error } : {}),
          blocks: m.answer.blocks,
          sources: m.answer.sources,
          queries: m.answer.queries,
        },
  );
}
