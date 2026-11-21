import { describe, expect, test } from 'vitest';
import { parseServerConfig } from './config';

const KEY = Buffer.alloc(32, 7).toString('base64');
const minimal = { MONGO_URL: 'mongodb://mongo:27017', SLACK_TEAM_ID: 'T0TEAM', ENCRYPTION_KEY: KEY };

describe('server config from environment', () => {
  test('applies defaults', () => {
    expect(parseServerConfig(minimal)).toEqual({
      mongoUrl: 'mongodb://mongo:27017',
      mongoDb: 'botley',
      uploadsDir: 'data/uploads',
      core: { slackTeamId: 'T0TEAM', adminSlackUserIds: [], encryptionKey: KEY },
      llm: null,
    });
  });

  describe('LLM providers', () => {
    test.each([
      ['anthropic', 'ANTHROPIC_API_KEY', { apiKey: 'k' }],
      ['openai', 'OPENAI_API_KEY', { apiKey: 'k' }],
      ['google', 'GOOGLE_GENERATIVE_AI_API_KEY', { apiKey: 'k' }],
      ['openrouter', 'OPENROUTER_API_KEY', { apiKey: 'k' }],
      ['groq', 'GROQ_API_KEY', { apiKey: 'k' }],
      ['ollama', 'OLLAMA_BASE_URL', { baseUrl: 'k' }],
    ])('%s is pre-selected with LLM_PROVIDER and %s', (provider, keyVar, credentials) => {
      const config = parseServerConfig({ ...minimal, LLM_PROVIDER: provider, [keyVar]: 'k' });

      expect(config.llm).toEqual({ defaultProvider: provider, credentials: { [provider]: credentials } });
    });

    test('Ollama defaults to a local server', () => {
      const config = parseServerConfig({ ...minimal, LLM_PROVIDER: 'ollama' });

      expect(config.llm?.credentials.ollama).toEqual({ baseUrl: 'http://localhost:11434/api' });
    });

    test('keeps every configured key, so another provider can be chosen later', () => {
      const config = parseServerConfig({
        ...minimal,
        LLM_PROVIDER: 'openai',
        OPENAI_API_KEY: 'o',
        GROQ_API_KEY: 'g',
      });

      expect(config.llm?.credentials).toEqual({ openai: { apiKey: 'o' }, groq: { apiKey: 'g' } });
    });

    test('keys without LLM_PROVIDER make providers available to choose, with none pre-selected', () => {
      const config = parseServerConfig({ ...minimal, ANTHROPIC_API_KEY: 'a', OLLAMA_BASE_URL: 'http://ollama:11434/api' });

      expect(config.llm).toEqual({
        defaultProvider: null,
        credentials: { anthropic: { apiKey: 'a' }, ollama: { baseUrl: 'http://ollama:11434/api' } },
      });
    });

    test('an OpenAI-compatible server is offered once its base URL is set, with an optional key and name', () => {
      const bare = parseServerConfig({ ...minimal, OPENAI_COMPATIBLE_BASE_URL: 'http://vllm:8000/v1' });
      const full = parseServerConfig({
        ...minimal,
        LLM_PROVIDER: 'openai-compatible',
        OPENAI_COMPATIBLE_BASE_URL: 'https://api.deepseek.com/v1',
        OPENAI_COMPATIBLE_API_KEY: 'sk-d',
        OPENAI_COMPATIBLE_NAME: 'DeepSeek',
      });

      expect(bare.llm).toEqual({ defaultProvider: null, credentials: { 'openai-compatible': { baseUrl: 'http://vllm:8000/v1' } } });
      expect(full.llm).toEqual({
        defaultProvider: 'openai-compatible',
        credentials: { 'openai-compatible': { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-d' } },
        labels: { 'openai-compatible': 'DeepSeek' },
      });
    });

    test('an OpenAI-compatible server needs an http(s) base URL', () => {
      expect(() => parseServerConfig({ ...minimal, LLM_PROVIDER: 'openai-compatible' })).toThrow(/OPENAI_COMPATIBLE_BASE_URL/);
      expect(() => parseServerConfig({ ...minimal, OPENAI_COMPATIBLE_BASE_URL: 'vllm:8000' })).toThrow(
        /OPENAI_COMPATIBLE_BASE_URL must be an http\(s\) URL/,
      );
      expect(() => parseServerConfig({ ...minimal, OPENAI_COMPATIBLE_API_KEY: 'k' })).toThrow(/OPENAI_COMPATIBLE_BASE_URL/);
    });

    test('refuses an unknown provider or a missing key', () => {
      expect(() => parseServerConfig({ ...minimal, LLM_PROVIDER: 'skynet' })).toThrow(/LLM_PROVIDER/);
      expect(() => parseServerConfig({ ...minimal, LLM_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
    });
  });

  describe('Slack bot tokens', () => {
    test('are read when set', () => {
      const config = parseServerConfig({ ...minimal, SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1' });

      expect(config.slack).toEqual({ botToken: 'xoxb-1', appToken: 'xapp-1' });
    });

    test('are optional (the worker then runs without Slack)', () => {
      expect(parseServerConfig(minimal).slack).toBeUndefined();
    });

    test('refuse tokens of the wrong kind', () => {
      expect(() => parseServerConfig({ ...minimal, SLACK_BOT_TOKEN: 'xapp-1' })).toThrow(/SLACK_BOT_TOKEN/);
      expect(() => parseServerConfig({ ...minimal, SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xoxb-2' })).toThrow(
        /SLACK_APP_TOKEN/,
      );
    });
  });

  describe('the web app URL (Slack "Open in dashboard" links)', () => {
    test('is APP_URL, else AUTH_URL, without a trailing slash', () => {
      expect(parseServerConfig({ ...minimal, AUTH_URL: 'https://botley.example/' }).core.appUrl).toBe('https://botley.example');
      expect(parseServerConfig({ ...minimal, AUTH_URL: 'https://a.example', APP_URL: 'https://b.example' }).core.appUrl).toBe(
        'https://b.example',
      );
    });

    test('must be an http(s) URL', () => {
      expect(() => parseServerConfig({ ...minimal, APP_URL: 'botley.example' })).toThrow(/APP_URL/);
    });
  });

  test('reads a comma-separated admin list, ignoring blanks and spaces', () => {
    const config = parseServerConfig({ ...minimal, ADMIN_SLACK_USER_IDS: ' U1, U2 ,,U3 ' });

    expect(config.core.adminSlackUserIds).toEqual(['U1', 'U2', 'U3']);
  });

  test('names every missing variable', () => {
    expect(() => parseServerConfig({})).toThrow(/MONGO_URL[\s\S]*SLACK_TEAM_ID[\s\S]*ENCRYPTION_KEY/);
  });

  test('accepts a hex encryption key and refuses one of the wrong length', () => {
    expect(parseServerConfig({ ...minimal, ENCRYPTION_KEY: 'ab'.repeat(32) }).core.encryptionKey).toBe('ab'.repeat(32));
    expect(() => parseServerConfig({ ...minimal, ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(/ENCRYPTION_KEY must be 32 bytes/);
  });
});
