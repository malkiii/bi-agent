/**
 * The web chat's streaming protocol: POST /api/chat answers with newline-delimited JSON,
 * one `ChatStreamEvent` per line. Dates travel as ISO strings.
 */
import type { Answer, AnswerEvent } from '@/core';

/** An Answer as the browser receives it (JSON: dates become strings). */
export type WireAnswer = Omit<Answer, 'startedAt' | 'finishedAt'> & { startedAt: string | Date; finishedAt: string | Date };

export type ChatStreamEvent =
  | { type: 'conversation'; id: string }
  | AnswerEvent
  | { type: 'answer'; answer: WireAnswer; /** The stored Answer message (for block downloads). */ messageId?: string }
  | { type: 'error'; message: string };

export interface ChatRequest {
  /** Omit to start a new Web Conversation. */
  conversationId?: string;
  prompt: string;
  /** The Data Sources the Conversation is locked to from this Prompt on; empty for none. Omit to keep the lock. */
  dataSourceIds?: string[];
}

/** Splits a stream of NDJSON text into events; keeps a partial last line for the next chunk. */
export function createNdjsonParser(onEvent: (event: ChatStreamEvent) => void) {
  let buffer = '';
  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onEvent(JSON.parse(line) as ChatStreamEvent);
    },
    end() {
      if (buffer.trim()) onEvent(JSON.parse(buffer) as ChatStreamEvent);
      buffer = '';
    },
  };
}
