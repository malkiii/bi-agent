import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelProvider, LlmChoice, LlmModel } from '../ports';

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
 */
export class MockLlm implements LanguageModelProvider {
  model = new MockLanguageModelV4({ doGenerate: () => Promise.reject(new Error('MockLlm: no turns scripted')) });
  /** Every provider/model a model was built for, in order. */
  readonly choices: LlmChoice[] = [];
  private providers: readonly string[] = ['mock'];
  private preselected: string | null = null;
  private labels: Record<string, string> = {};
  private models: Record<string, LlmModel[] | Error> = {};

  /**
   * Pretend these providers have configured credentials, LLM_PROVIDER is `defaultProvider`,
   * each provider offers `models` (an Error makes listing fail), and is named by `labels`
   * (else by its id).
   */
  configure({
    providers,
    defaultProvider = null,
    models = {},
    labels = {},
  }: {
    providers: readonly string[];
    defaultProvider?: string | null;
    models?: Record<string, LlmModel[] | Error>;
    labels?: Record<string, string>;
  }): void {
    this.providers = providers;
    this.preselected = defaultProvider;
    this.models = models;
    this.labels = labels;
  }

  configuredProviders() {
    return this.providers;
  }

  defaultProvider() {
    return this.preselected;
  }

  providerLabel(provider: string) {
    return this.labels[provider] ?? provider;
  }

  async listModels(provider: string) {
    if (!this.providers.includes(provider)) throw new Error(`MockLlm: ${provider} is not configured`);
    const models = this.models[provider] ?? [];
    if (models instanceof Error) throw models;
    return models;
  }

  /** Records `choice` and returns the scripted model, whatever provider was chosen. */
  async getModel(choice: LlmChoice) {
    if (!this.providers.includes(choice.provider)) throw new Error(`MockLlm: ${choice.provider} is not configured`);
    this.choices.push(choice);
    return this.model;
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
