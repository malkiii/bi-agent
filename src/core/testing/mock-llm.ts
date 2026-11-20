import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelProvider, LlmChoice, LlmOptions } from '../ports';

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

/** One scripted model turn: plain text, or tool calls (input is serialised for you). */
export type ScriptedTurn =
  | { text: string }
  | { toolCalls: { toolName: string; input: unknown }[] };

/**
 * LanguageModelProvider backed by the AI SDK's MockLanguageModelV4.
 * `script(...)` queues turns; each model call (generate or stream) consumes the next one
 * (the last turn repeats once the script runs out; an empty script makes every call fail).
 * `model.doGenerateCalls` / `model.doStreamCalls` hold the prompts the model received
 * (the App Core agent loop streams).
 * `configure(...)` sets the environment's default and configured providers (none by default);
 * `choices` records the LLM choice passed with each `getModel` call.
 */
export class MockLlm implements LanguageModelProvider {
  model = new MockLanguageModelV4({ doGenerate: () => Promise.reject(new Error('MockLlm: no turns scripted')) });

  choices: (LlmChoice | undefined)[] = [];
  private llmOptions: LlmOptions = { default: null, providers: [] };

  async getModel(choice?: LlmChoice) {
    this.choices.push(choice);
    return this.model;
  }

  options(): LlmOptions {
    return this.llmOptions;
  }

  configure(options: LlmOptions): void {
    this.llmOptions = options;
  }

  script(...turns: ScriptedTurn[]): MockLanguageModelV4 {
    let next = 0;
    const take = (): ScriptedTurn => {
      const turn = turns[Math.min(next++, turns.length - 1)];
      if (!turn) throw new Error('MockLlm: no turns scripted');
      return turn;
    };
    this.model = new MockLanguageModelV4({
      doGenerate: async () => toResult(take()),
      doStream: async () => ({ stream: simulateReadableStream({ chunks: toStreamParts(take()) }) }),
    });
    return this.model;
  }
}

let callSeq = 0;

function toResult(turn: ScriptedTurn): GenerateResult {
  if ('text' in turn) {
    return {
      content: [{ type: 'text', text: turn.text }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: [],
    };
  }
  return {
    content: turn.toolCalls.map((c) => ({
      type: 'tool-call' as const,
      toolCallId: `call_${++callSeq}`,
      toolName: c.toolName,
      input: JSON.stringify(c.input),
    })),
    finishReason: { unified: 'tool-calls', raw: undefined },
    usage,
    warnings: [],
  };
}

function toStreamParts(turn: ScriptedTurn): StreamPart[] {
  const parts: StreamPart[] = [{ type: 'stream-start', warnings: [] }];
  if ('text' in turn) {
    const id = `text_${++callSeq}`;
    if (turn.text) {
      parts.push({ type: 'text-start', id }, { type: 'text-delta', id, delta: turn.text }, { type: 'text-end', id });
    }
    parts.push({ type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage });
    return parts;
  }
  for (const c of turn.toolCalls) {
    parts.push({ type: 'tool-call', toolCallId: `call_${++callSeq}`, toolName: c.toolName, input: JSON.stringify(c.input) });
  }
  parts.push({ type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage });
  return parts;
}
