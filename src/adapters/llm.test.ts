import { expect, test } from 'vitest';
import { createLanguageModelProvider } from './llm';
import { LLM_PROVIDERS } from './llm-settings';

test.each(LLM_PROVIDERS)('builds a %s model for the chosen model id, without calling it', async (provider) => {
  const llm = createLanguageModelProvider({
    defaultProvider: null,
    credentials: { [provider]: provider === 'ollama' ? { baseUrl: 'http://ollama:11434/api' } : { apiKey: 'k' } },
  });

  const model = await llm.getModel({ provider, model: 'some-model' });

  expect(typeof model).toBe('object');
  expect(model).toMatchObject({ modelId: 'some-model', provider: expect.stringContaining(provider) });
});

test('offers only the providers with credentials, and the pre-selected one', () => {
  const llm = createLanguageModelProvider({
    defaultProvider: 'openai',
    credentials: { groq: { apiKey: 'g' }, openai: { apiKey: 'o' } },
  });

  expect(llm.configuredProviders()).toEqual(['openai', 'groq']);
  expect(llm.defaultProvider()).toBe('openai');
});

test('refuses a provider without credentials', async () => {
  const llm = createLanguageModelProvider({ defaultProvider: null, credentials: { openai: { apiKey: 'o' } } });

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
  const llm = createLanguageModelProvider({ defaultProvider: null, credentials: { openai: { apiKey: 'sk-o' } } }, fakeFetch);

  expect(await llm.listModels('openai')).toEqual([{ id: 'gpt-5', name: 'gpt-5' }]);
  expect(requests).toEqual([{ url: 'https://api.openai.com/v1/models', headers: { Authorization: 'Bearer sk-o' } }]);
});
