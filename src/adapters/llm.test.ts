import { generateText } from 'ai';
import { describe, expect, test } from 'vitest';
import { createLanguageModelProvider } from './llm';
import { LLM_PROVIDERS } from './llm-settings';

test.each(LLM_PROVIDERS)('builds a %s model for the chosen model id, without calling it', async (provider) => {
  const llm = createLanguageModelProvider({
    credentials: { [provider]: { apiKey: 'k', baseUrl: 'http://server:1234/v1' } },
  });

  const model = await llm.getModel({ provider, model: 'some-model' });

  expect(typeof model).toBe('object');
  expect(model).toMatchObject({ modelId: 'some-model', provider: expect.stringContaining(provider) });
});

test('offers only the providers with credentials, in a fixed order', () => {
  const llm = createLanguageModelProvider({ credentials: { groq: { apiKey: 'g' }, openai: { apiKey: 'o' } } });

  expect(llm.configuredProviders()).toEqual(['openai', 'groq']);
});

describe('the default model, until an admin chooses', () => {
  const listing = (ids: string[]) => (async () => Response.json({ data: ids.map((id) => ({ id })) })) as unknown as typeof fetch;

  test('is a well-known model the provider lists', async () => {
    const llm = createLanguageModelProvider({ credentials: { openai: { apiKey: 'o' } } }, listing(['o3', 'gpt-5', 'gpt-4.1']));

    expect(await llm.defaultModel('openai')).toBe('gpt-5');
  });

  test('is the provider’s first model by id when none is well known', async () => {
    const llm = createLanguageModelProvider(
      { credentials: { 'openai-compatible': { baseUrl: 'http://vllm:8000/v1' } } },
      listing(['qwen3-32b', 'llama-4-scout', 'text-embedding-3']),
    );

    expect(await llm.defaultModel('openai-compatible')).toBe('llama-4-scout');
  });

  test('is none when the provider lists no models', async () => {
    const llm = createLanguageModelProvider({ credentials: { 'openai-compatible': { baseUrl: 'http://x/v1' } } }, listing([]));

    expect(await llm.defaultModel('openai-compatible')).toBeNull();
  });
});

test('refuses a provider without credentials', async () => {
  const llm = createLanguageModelProvider({ credentials: { openai: { apiKey: 'o' } } });

  await expect(llm.getModel({ provider: 'anthropic', model: 'claude' })).rejects.toThrow(/anthropic/);
  await expect(llm.getModel({ provider: 'skynet', model: 'x' })).rejects.toThrow(/skynet/);
  await expect(llm.listModels('anthropic')).rejects.toThrow(/anthropic/);
});

test('lists models with the configured credentials', async () => {
  const requests: { url: string; headers: HeadersInit | undefined }[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url, headers: init?.headers });
    return Response.json({ data: [{ id: 'gpt-5' }, { id: 'text-embedding-3-small' }] });
  }) as typeof fetch;
  const llm = createLanguageModelProvider({ credentials: { openai: { apiKey: 'sk-o' } } }, fakeFetch);

  expect(await llm.listModels('openai')).toEqual([{ id: 'gpt-5', name: 'gpt-5' }]);
  expect(requests).toEqual([{ url: 'https://api.openai.com/v1/models', headers: { Authorization: 'Bearer sk-o' } }]);
});

describe('an OpenAI-compatible server', () => {
  const chatCompletion = {
    id: 'c1',
    created: 0,
    model: 'qwen3',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  };

  function recordingFetch(body: unknown) {
    const requests: { url: string; headers: Record<string, string> }[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      return Response.json(body);
    }) as typeof fetch;
    return { requests, fetchFn };
  }

  test('answers through Chat Completions at the configured base URL, with the key when set', async () => {
    const { requests, fetchFn } = recordingFetch(chatCompletion);
    const llm = createLanguageModelProvider(
      { credentials: { 'openai-compatible': { baseUrl: 'http://vllm:8000/v1/', apiKey: 'sk-v' } } },
      fetchFn,
    );

    const { text } = await generateText({ model: await llm.getModel({ provider: 'openai-compatible', model: 'qwen3' }), prompt: 'Hello?' });

    expect(text).toBe('Hi');
    expect(requests).toMatchObject([{ url: 'http://vllm:8000/v1/chat/completions', headers: { authorization: 'Bearer sk-v' } }]);
  });

  test('answers without an Authorization header when no key is set', async () => {
    const { requests, fetchFn } = recordingFetch(chatCompletion);
    const llm = createLanguageModelProvider(
      { credentials: { 'openai-compatible': { baseUrl: 'http://lmstudio:1234/v1' } } },
      fetchFn,
    );

    await generateText({ model: await llm.getModel({ provider: 'openai-compatible', model: 'qwen3' }), prompt: 'Hello?' });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers).not.toHaveProperty('authorization');
  });

  test('lists models from its /models endpoint, without a key when none is set', async () => {
    const { requests, fetchFn } = recordingFetch({ data: [{ id: 'qwen3' }, { id: 'nomic-embed-text' }] });
    const llm = createLanguageModelProvider(
      { credentials: { 'openai-compatible': { baseUrl: 'http://lmstudio:1234/v1/' } } },
      fetchFn,
    );

    expect(await llm.listModels('openai-compatible')).toEqual([{ id: 'qwen3', name: 'qwen3' }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('http://lmstudio:1234/v1/models');
    expect(requests[0]?.headers).not.toHaveProperty('authorization');
  });

  test('is labelled with its configured name, other providers with theirs', () => {
    const llm = createLanguageModelProvider({
      credentials: { 'openai-compatible': { baseUrl: 'http://vllm:8000/v1' }, openai: { apiKey: 'o' } },
      labels: { 'openai-compatible': 'vLLM' },
    });
    const unnamed = createLanguageModelProvider({ credentials: { 'openai-compatible': { baseUrl: 'http://x/v1' } } });

    expect(llm.providerLabel('openai-compatible')).toBe('vLLM');
    expect(llm.providerLabel('openai')).toBe('OpenAI');
    expect(unnamed.providerLabel('openai-compatible')).toBe('OpenAI-compatible');
  });
});
