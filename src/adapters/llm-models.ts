/**
 * Asks each LLM provider which models it offers, keeping only chat models that can drive the
 * agent loop (text out, tool calls). Filtering is best effort: a provider's metadata is used
 * where it has any, else model ids that are clearly not chat models are dropped.
 */
import type { LlmModel } from '@/core';
import type { LlmCredentials, LlmProviderName } from './llm-settings';

type Fetch = typeof fetch;

const TIMEOUT_MS = 10_000;

/** Ids of embedding, speech, image, moderation, completion-only and other non-chat models. */
const NOT_CHAT =
  /embed|whisper|tts|transcribe|speech|audio|realtime|dall-e|image|imagen|veo|sora|moderation|guard|babbage|davinci|instruct|search|computer-use|orpheus|playai|aqa/i;

export const isChatModelId = (id: string) => !NOT_CHAT.test(id);

const model = (id: string, name?: string | null): LlmModel => ({ id, name: name?.trim() || id });

async function getJson(fetchFn: Fetch, url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? ' (check the API key)' : '';
    throw new Error(`the provider answered ${response.status} ${response.statusText}${hint}`.trim());
  }
  return response.json();
}

/** OpenAI-style `{ data: [{ id }] }`. */
interface IdList {
  data?: { id: string; active?: boolean }[];
}

export interface AnthropicModels {
  data?: { id: string; display_name?: string }[];
  has_more?: boolean;
  last_id?: string | null;
}

export interface GoogleModels {
  models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
  nextPageToken?: string;
}

export interface OpenRouterModels {
  data?: {
    id: string;
    name?: string;
    architecture?: { output_modalities?: string[] };
    supported_parameters?: string[];
  }[];
}

export interface OllamaTags {
  models?: { name: string }[];
}

/** Every Anthropic model is a chat model. */
export const anthropicModels = (page: AnthropicModels) => (page.data ?? []).map((m) => model(m.id, m.display_name));

export const openAiStyleModels = (list: IdList) =>
  (list.data ?? []).filter((m) => m.active !== false && isChatModelId(m.id)).map((m) => model(m.id));

/** Only models that generate content; Google prefixes ids with `models/`. */
export const googleModels = (page: GoogleModels) =>
  (page.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent') ?? true)
    .map((m) => ({ ...m, id: m.name.replace(/^models\//, '') }))
    .filter((m) => isChatModelId(m.id))
    .map((m) => model(m.id, m.displayName));

/** Text output with tool calling, when OpenRouter says so. */
export const openRouterModels = (list: OpenRouterModels) =>
  (list.data ?? [])
    .filter((m) => m.architecture?.output_modalities?.includes('text') ?? true)
    .filter((m) => m.supported_parameters?.includes('tools') ?? true)
    .map((m) => model(m.id, m.name));

export const ollamaModels = (tags: OllamaTags) =>
  (tags.models ?? []).filter((m) => isChatModelId(m.name)).map((m) => model(m.name));

export async function listProviderModels(
  provider: LlmProviderName,
  { apiKey = '', baseUrl = '' }: LlmCredentials,
  fetchFn: Fetch = fetch,
): Promise<LlmModel[]> {
  const bearer = { Authorization: `Bearer ${apiKey}` };
  switch (provider) {
    case 'anthropic': {
      const models: LlmModel[] = [];
      let after: string | null | undefined;
      do {
        const query = new URLSearchParams({ limit: '1000', ...(after && { after_id: after }) });
        const page = (await getJson(fetchFn, `https://api.anthropic.com/v1/models?${query}`, {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        })) as AnthropicModels;
        models.push(...anthropicModels(page));
        after = page.has_more ? page.last_id : null;
      } while (after);
      return models;
    }
    case 'openai':
      return openAiStyleModels((await getJson(fetchFn, 'https://api.openai.com/v1/models', bearer)) as IdList);
    case 'groq':
      return openAiStyleModels((await getJson(fetchFn, 'https://api.groq.com/openai/v1/models', bearer)) as IdList);
    case 'google': {
      const models: LlmModel[] = [];
      let token: string | undefined;
      do {
        const query = new URLSearchParams({ pageSize: '1000', ...(token && { pageToken: token }) });
        const page = (await getJson(fetchFn, `https://generativelanguage.googleapis.com/v1beta/models?${query}`, {
          'x-goog-api-key': apiKey,
        })) as GoogleModels;
        models.push(...googleModels(page));
        token = page.nextPageToken;
      } while (token);
      return models;
    }
    case 'openrouter':
      return openRouterModels((await getJson(fetchFn, 'https://openrouter.ai/api/v1/models', bearer)) as OpenRouterModels);
    case 'ollama':
      return ollamaModels((await getJson(fetchFn, `${baseUrl.replace(/\/+$/, '')}/tags`)) as OllamaTags);
  }
}
