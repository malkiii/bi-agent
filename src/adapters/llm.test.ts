import { expect, test } from 'vitest';
import { createLanguageModelProvider } from './llm';
import { LLM_PROVIDERS } from './llm-settings';

test.each(LLM_PROVIDERS)('builds a %s model for the chosen model id, without calling it', async (provider) => {
  const llm = createLanguageModelProvider({
    defaultChoice: null,
    credentials: { [provider]: provider === 'ollama' ? { baseUrl: 'http://ollama:11434/api' } : { apiKey: 'k' } },
  });

  const model = await llm.getModel({ provider, model: 'some-model' });

  expect(typeof model).toBe('object');
  expect(model).toMatchObject({ modelId: 'some-model', provider: expect.stringContaining(provider) });
});

test('offers only the providers with credentials, and the environment default', () => {
  const llm = createLanguageModelProvider({
    defaultChoice: { provider: 'openai', model: 'gpt-x' },
    credentials: { groq: { apiKey: 'g' }, openai: { apiKey: 'o' } },
  });

  expect(llm.configuredProviders()).toEqual(['openai', 'groq']);
  expect(llm.defaultChoice()).toEqual({ provider: 'openai', model: 'gpt-x' });
});

test('refuses a provider without credentials', async () => {
  const llm = createLanguageModelProvider({ defaultChoice: null, credentials: { openai: { apiKey: 'o' } } });

  await expect(llm.getModel({ provider: 'anthropic', model: 'claude' })).rejects.toThrow(/anthropic/);
  await expect(llm.getModel({ provider: 'skynet', model: 'x' })).rejects.toThrow(/skynet/);
});
