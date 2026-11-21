import { describe, expect, test } from 'vitest';
import {
  anthropicModels,
  googleModels,
  isChatModelId,
  listProviderModels,
  ollamaModels,
  openAiStyleModels,
  openRouterModels,
} from './llm-models';

/** Answers each URL with the next queued body (or status), recording what was asked. */
function fakeFetch(...responses: (unknown | { status: number })[]) {
  const urls: string[] = [];
  const fn = (async (url: string) => {
    urls.push(url);
    const next = responses.shift();
    if (next && typeof next === 'object' && 'status' in next) {
      return new Response('nope', { status: (next as { status: number }).status, statusText: 'Unauthorized' });
    }
    return Response.json(next);
  }) as typeof fetch;
  return { fn, urls };
}

describe('keeping chat models only', () => {
  test.each(['gpt-5', 'gpt-4.1-mini', 'o3', 'llama-3.3-70b-versatile', 'gemini-2.5-pro', 'qwen3:8b'])('keeps %s', (id) => {
    expect(isChatModelId(id)).toBe(true);
  });

  test.each([
    'text-embedding-3-large',
    'whisper-1',
    'tts-1-hd',
    'gpt-4o-mini-tts',
    'gpt-4o-transcribe',
    'dall-e-3',
    'gpt-image-1',
    'omni-moderation-latest',
    'gpt-4o-realtime-preview',
    'gpt-4o-audio-preview',
    'gpt-3.5-turbo-instruct',
    'davinci-002',
    'gpt-4o-search-preview',
    'meta-llama/llama-guard-4-12b',
    'nomic-embed-text:latest',
    'imagen-4.0-generate-001',
  ])('drops %s', (id) => {
    expect(isChatModelId(id)).toBe(false);
  });

  test('OpenAI and Groq: drops inactive and non-chat models', () => {
    expect(openAiStyleModels({ data: [{ id: 'gpt-5' }, { id: 'whisper-1' }, { id: 'old', active: false }] })).toEqual([
      { id: 'gpt-5', name: 'gpt-5' },
    ]);
  });

  test('Anthropic: keeps every model, with its display name', () => {
    expect(anthropicModels({ data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }] })).toEqual([
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
    ]);
  });

  test('Google: keeps content generators and strips the models/ prefix', () => {
    expect(
      googleModels({
        models: [
          { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
        ],
      }),
    ).toEqual([{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }]);
  });

  test('OpenRouter: keeps text models that support tools', () => {
    expect(
      openRouterModels({
        data: [
          { id: 'anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5', architecture: { output_modalities: ['text'] }, supported_parameters: ['tools'] },
          { id: 'some/no-tools', architecture: { output_modalities: ['text'] }, supported_parameters: ['temperature'] },
          { id: 'some/image-out', architecture: { output_modalities: ['image'] }, supported_parameters: ['tools'] },
        ],
      }),
    ).toEqual([{ id: 'anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }]);
  });

  test('Ollama: drops embedding models', () => {
    expect(ollamaModels({ models: [{ name: 'llama3.2:latest' }, { name: 'nomic-embed-text:latest' }] })).toEqual([
      { id: 'llama3.2:latest', name: 'llama3.2:latest' },
    ]);
  });
});

describe('asking the provider', () => {
  test('Anthropic: follows pages', async () => {
    const { fn, urls } = fakeFetch(
      { data: [{ id: 'a' }], has_more: true, last_id: 'a' },
      { data: [{ id: 'b' }], has_more: false, last_id: 'b' },
    );

    expect(await listProviderModels('anthropic', { apiKey: 'k' }, fn)).toEqual([
      { id: 'a', name: 'a' },
      { id: 'b', name: 'b' },
    ]);
    expect(urls[1]).toContain('after_id=a');
  });

  test('Google: follows page tokens', async () => {
    const { fn, urls } = fakeFetch(
      { models: [{ name: 'models/gemini-a' }], nextPageToken: 't2' },
      { models: [{ name: 'models/gemini-b' }] },
    );

    expect((await listProviderModels('google', { apiKey: 'k' }, fn)).map((m) => m.id)).toEqual(['gemini-a', 'gemini-b']);
    expect(urls[1]).toContain('pageToken=t2');
  });

  test('Ollama: asks the configured server', async () => {
    const { fn, urls } = fakeFetch({ models: [{ name: 'llama3.2' }] });

    await listProviderModels('ollama', { baseUrl: 'http://ollama:11434/api/' }, fn);

    expect(urls).toEqual(['http://ollama:11434/api/tags']);
  });

  test('a refused key reads as such', async () => {
    const { fn } = fakeFetch({ status: 401 });

    await expect(listProviderModels('groq', { apiKey: 'bad' }, fn)).rejects.toThrow(/401.*API key/);
  });
});
