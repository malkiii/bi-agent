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

const settings = {
  provider: 'anthropic' as const,
  model: 'claude-env',
  credentials: { anthropic: { apiKey: 'a' }, groq: { apiKey: 'g' } },
};

test('offers only the providers with configured credentials, and the environment default', () => {
  expect(createLanguageModelProvider(settings).options?.()).toEqual({
    default: { provider: 'anthropic', model: 'claude-env' },
    providers: ['anthropic', 'groq'],
  });
});

test('builds the chosen provider and model instead of the default', async () => {
  const model = await createLanguageModelProvider(settings).getModel({ provider: 'groq', model: 'llama-x' });

  expect(model).toMatchObject({ modelId: 'llama-x', provider: expect.stringContaining('groq') });
});

test('refuses a provider without credentials', async () => {
  await expect(createLanguageModelProvider(settings).getModel({ provider: 'openai', model: 'gpt-x' })).rejects.toThrow(
    /openai/,
  );
});
