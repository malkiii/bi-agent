import { expect, test } from 'vitest';
import { createLanguageModelProvider } from './llm';
import { LLM_PROVIDERS } from './llm-settings';

test.each(LLM_PROVIDERS)('builds a %s model from settings, without calling it', async (provider) => {
  const llm = createLanguageModelProvider({
    provider,
    model: 'some-model',
    credentials: { [provider]: provider === 'ollama' ? { baseUrl: 'http://ollama:11434/api' } : { apiKey: 'k' } },
  });

  const model = await llm.getModel();

  expect(typeof model).toBe('object');
  expect(model).toMatchObject({ modelId: 'some-model', provider: expect.stringContaining(provider) });
});
