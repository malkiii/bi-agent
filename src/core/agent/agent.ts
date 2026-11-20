/**
 * The agent loop: one Prompt (with the Conversation's history) in, one Answer out.
 * Built on the AI SDK's tool-calling loop (`streamText` + `stopWhen`). It knows nothing
 * about web or Slack: callers pass history as model messages and receive `AnswerEvent`s.
 */
import { isStepCount, streamText, type ModelMessage, type ToolSet } from 'ai';
import type { LanguageModelProvider } from '../ports';
import type { Answer, AnswerEvent } from '../conversations/answer';
import { AnswerDraft } from './answer-draft';
import type { AgentCatalog } from './catalog';
import { builtInToolkits, type AgentToolkitFactory } from './tools';

/** Model steps (tool rounds) allowed per Answer. */
export const MAX_AGENT_STEPS = 16;

export const FAILED_ANSWER_MESSAGE =
  "Sorry, I couldn't finish this Answer. Try rephrasing your question, or ask an admin to check Botley's settings.";

const BASE_INSTRUCTIONS = [
  'You are Botley, a friendly BI analyst. You answer business questions from the Data Sources you can query.',
  'Start with listDatasets, use describeDataset when you need column details, then runQuery.',
  'Never invent numbers: every figure in the Answer must come from a query result.',
  'If the data cannot answer the question, say so briefly with emitText.',
].join('\n');

export interface RunAgentInput {
  llm: LanguageModelProvider;
  catalog: AgentCatalog;
  /** Earlier turns of the Conversation. */
  history: ModelMessage[];
  prompt: string;
  now: () => Date;
  onEvent?: (event: AnswerEvent) => void;
  signal?: AbortSignal;
  /** Sees the underlying error of a failed Answer (for logging). */
  onError?: (error: unknown) => void;
  toolkits?: readonly AgentToolkitFactory[];
}

/** Never throws for model or tool failures: they produce a `failed` Answer. */
export async function runAgent(input: RunAgentInput): Promise<Answer> {
  const answer = new AnswerDraft((event) => input.onEvent?.(event), input.now());
  const kits = (input.toolkits ?? builtInToolkits).map((make) => make({ catalog: input.catalog, answer }));
  const tools: ToolSet = Object.assign({}, ...kits.map((k) => k.tools));
  const instructions = [BASE_INSTRUCTIONS, ...kits.flatMap((k) => (k.instructions ? [k.instructions] : []))].join('\n');

  let usage = { inputTokens: 0, outputTokens: 0 };
  try {
    const result = streamText({
      model: await input.llm.getModel(),
      instructions,
      messages: [...input.history, { role: 'user', content: input.prompt }],
      tools,
      stopWhen: isStepCount(MAX_AGENT_STEPS),
      abortSignal: input.signal,
    });
    let finalText = '';
    for await (const part of result.stream) {
      if (part.type === 'error') throw part.error;
      if (part.type === 'start-step') finalText = '';
      if (part.type === 'text-delta') finalText += part.text;
    }
    const total = await result.usage;
    usage = { inputTokens: total.inputTokens ?? 0, outputTokens: total.outputTokens ?? 0 };
    // Models sometimes answer in plain text instead of calling emitText; keep it.
    if (finalText.trim()) answer.addBlock({ type: 'text', markdown: finalText.trim() });
    return answer.finish({ usage, finishedAt: input.now() });
  } catch (error) {
    input.onError?.(error);
    return answer.finish({ usage, finishedAt: input.now(), error: FAILED_ANSWER_MESSAGE });
  }
}
