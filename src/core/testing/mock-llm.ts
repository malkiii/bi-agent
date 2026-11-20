import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelProvider } from '../ports';

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

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
 * `script(...)` queues turns; each model call consumes the next one
 * (the last turn repeats once the script runs out). `model.doGenerateCalls`
 * holds the prompts the model received.
 */
export class MockLlm implements LanguageModelProvider {
  model = new MockLanguageModelV4({ doGenerate: () => Promise.reject(new Error('MockLlm: no turns scripted')) });

  async getModel() {
    return this.model;
  }

  script(...turns: ScriptedTurn[]): MockLanguageModelV4 {
    this.model = new MockLanguageModelV4({ doGenerate: turns.map(toResult) });
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
