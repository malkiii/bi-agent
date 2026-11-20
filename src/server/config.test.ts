import { describe, expect, test } from 'vitest';
import { parseServerConfig } from './config';

const KEY = Buffer.alloc(32, 7).toString('base64');
const minimal = { MONGO_URL: 'mongodb://mongo:27017', SLACK_TEAM_ID: 'T0TEAM', ENCRYPTION_KEY: KEY };

describe('server config from environment', () => {
  test('applies defaults', () => {
    expect(parseServerConfig(minimal)).toEqual({
      mongoUrl: 'mongodb://mongo:27017',
      mongoDb: 'botley',
      core: { slackTeamId: 'T0TEAM', adminSlackUserIds: [], encryptionKey: KEY },
      llm: null,
    });
  });

  describe('LLM provider and model', () => {
    test.each([
      ['anthropic', 'ANTHROPIC_API_KEY', { apiKey: 'k' }],
      ['openai', 'OPENAI_API_KEY', { apiKey: 'k' }],
      ['google', 'GOOGLE_GENERATIVE_AI_API_KEY', { apiKey: 'k' }],
      ['openrouter', 'OPENROUTER_API_KEY', { apiKey: 'k' }],
      ['groq', 'GROQ_API_KEY', { apiKey: 'k' }],
      ['ollama', 'OLLAMA_BASE_URL', { baseUrl: 'k' }],
    ])('%s is selected with LLM_PROVIDER, LLM_MODEL and %s', (provider, keyVar, credentials) => {
      const config = parseServerConfig({ ...minimal, LLM_PROVIDER: provider, LLM_MODEL: 'some-model', [keyVar]: 'k' });

      expect(config.llm).toEqual({ provider, model: 'some-model', credentials: { [provider]: credentials } });
    });

    test('Ollama defaults to a local server', () => {
      const config = parseServerConfig({ ...minimal, LLM_PROVIDER: 'ollama', LLM_MODEL: 'llama3.2' });

      expect(config.llm?.credentials.ollama).toEqual({ baseUrl: 'http://localhost:11434/api' });
    });

    test('keeps every configured key, so another provider can be chosen later', () => {
      const config = parseServerConfig({
        ...minimal,
        LLM_PROVIDER: 'openai',
        LLM_MODEL: 'gpt-x',
        OPENAI_API_KEY: 'o',
        GROQ_API_KEY: 'g',
      });

      expect(config.llm?.credentials).toEqual({ openai: { apiKey: 'o' }, groq: { apiKey: 'g' } });
    });

    test('refuses an unknown provider, a missing model or a missing key', () => {
      expect(() => parseServerConfig({ ...minimal, LLM_PROVIDER: 'skynet', LLM_MODEL: 'm' })).toThrow(/LLM_PROVIDER/);
      expect(() => parseServerConfig({ ...minimal, LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'k' })).toThrow(/LLM_MODEL/);
      expect(() => parseServerConfig({ ...minimal, LLM_PROVIDER: 'anthropic', LLM_MODEL: 'm' })).toThrow(
        /ANTHROPIC_API_KEY/,
      );
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
