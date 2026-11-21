import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createAppCore, ForbiddenError, ModelListError, ValidationError } from '@/core';
import { createTestHarness, MockLlm, type TestHarness } from '@/core/testing';

const ADMIN = 'UADMIN';
const MEMBER = 'UMEMBER';

let h: TestHarness;
beforeEach(async () => {
  h = await createTestHarness({ config: { slackTeamId: 'T1', adminSlackUserIds: [ADMIN] } });
  for (const slackUserId of [ADMIN, MEMBER]) {
    await h.core.users.signIn({ slackUserId, slackTeamId: 'T1', name: slackUserId, email: null, image: null });
  }
  h.llm.configure({ providers: ['anthropic', 'openai'], defaultProvider: 'anthropic' });
  // Start from a fresh install: no model chosen yet.
  await h.db.collection('appSettings').deleteMany({});
});
afterEach(() => h.close());

async function askSomething() {
  h.llm.script({ text: 'Hi' });
  const conversation = await h.core.conversations.startWeb(MEMBER);
  return h.core.conversations.ask(MEMBER, conversation.id, 'Hello?');
}

describe('choosing the LLM in admin settings', () => {
  test('a new Prompt uses the provider and model an admin chose', async () => {
    await h.core.llmSettings.set(ADMIN, { provider: 'openai', model: 'gpt-chosen' });

    await askSomething();

    expect(h.llm.choices.at(-1)).toEqual({ provider: 'openai', model: 'gpt-chosen' });
  });

  test('another process sees the change on its next Prompt, without a restart', async () => {
    const llm = new MockLlm();
    llm.configure({ providers: ['anthropic', 'openai'] });
    const worker = createAppCore({ db: h.db, clock: h.clock, slack: h.slack, llm, drivers: {}, config: h.config });
    await h.core.llmSettings.set(ADMIN, { provider: 'anthropic', model: 'claude-first' });
    llm.script({ text: 'Hi' });
    const before = await worker.conversations.startWeb(MEMBER);
    await worker.conversations.ask(MEMBER, before.id, 'Hello?');

    await h.core.llmSettings.set(ADMIN, { provider: 'openai', model: 'gpt-chosen' });
    await worker.conversations.ask(MEMBER, before.id, 'And now?');

    expect(llm.choices).toEqual([
      { provider: 'anthropic', model: 'claude-first' },
      { provider: 'openai', model: 'gpt-chosen' },
    ]);
  });

  test('until an admin chooses, nothing is active and LLM_PROVIDER is only pre-selected', async () => {
    const answer = await askSomething();

    expect(answer.status).toBe('failed');
    expect(h.llm.choices).toEqual([]);
    expect(await h.core.llmSettings.get(ADMIN)).toEqual({
      active: null,
      providers: ['anthropic', 'openai'],
      labels: { anthropic: 'anthropic', openai: 'openai' },
      defaultProvider: 'anthropic',
    });
  });

  test('admins see each provider by its display name, e.g. the configured name of an OpenAI-compatible server', async () => {
    h.llm.configure({ providers: ['openai', 'openai-compatible'], labels: { openai: 'OpenAI', 'openai-compatible': 'vLLM' } });

    expect((await h.core.llmSettings.get(ADMIN)).labels).toEqual({ openai: 'OpenAI', 'openai-compatible': 'vLLM' });
  });

  test('a pre-selected provider without a key is not offered', async () => {
    h.llm.configure({ providers: ['openai'], defaultProvider: 'anthropic' });

    expect((await h.core.llmSettings.get(ADMIN)).defaultProvider).toBeNull();
  });

  test('admins see only the providers whose keys are configured, and the active choice', async () => {
    const view = await h.core.llmSettings.set(ADMIN, { provider: 'openai', model: ' gpt-chosen ' });

    expect(view).toEqual({
      active: { provider: 'openai', model: 'gpt-chosen' },
      providers: ['anthropic', 'openai'],
      labels: { anthropic: 'anthropic', openai: 'openai' },
      defaultProvider: 'anthropic',
    });
  });

  test('a provider without a configured key, or an empty model, is refused', async () => {
    await expect(h.core.llmSettings.set(ADMIN, { provider: 'groq', model: 'llama' })).rejects.toMatchObject({
      fieldErrors: { provider: expect.any(String) },
    });
    await expect(h.core.llmSettings.set(ADMIN, { provider: 'openai', model: '  ' })).rejects.toBeInstanceOf(ValidationError);

    expect((await h.core.llmSettings.get(ADMIN)).active).toBeNull();
  });

  test('members can neither see nor change the setting, nor list models', async () => {
    await expect(h.core.llmSettings.get(MEMBER)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(h.core.llmSettings.set(MEMBER, { provider: 'openai', model: 'gpt-chosen' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(h.core.llmSettings.listModels(MEMBER, 'openai')).rejects.toBeInstanceOf(ForbiddenError);

    expect((await h.core.llmSettings.get(ADMIN)).active).toBeNull();
  });

  test('when the chosen provider loses its key, nothing is active until an admin chooses again', async () => {
    await h.core.llmSettings.set(ADMIN, { provider: 'openai', model: 'gpt-chosen' });
    h.llm.configure({ providers: ['anthropic'] });

    const answer = await askSomething();

    expect(answer.status).toBe('failed');
    expect((await h.core.llmSettings.get(ADMIN)).active).toBeNull();
  });

  test('with no LLM configured at all, the Answer fails instead of crashing', async () => {
    h.llm.configure({ providers: [] });

    const answer = await askSomething();

    expect(answer.status).toBe('failed');
  });
});

describe('listing a provider’s models', () => {
  test('admins get the models the provider offers, sorted by name', async () => {
    h.llm.configure({
      providers: ['openai'],
      models: {
        openai: [
          { id: 'gpt-5', name: 'gpt-5' },
          { id: 'gpt-4.1', name: 'GPT-4.1' },
          { id: 'o3', name: 'a reasoning model' },
        ],
      },
    });

    expect(await h.core.llmSettings.listModels(ADMIN, 'openai')).toEqual([
      { id: 'o3', name: 'a reasoning model' },
      { id: 'gpt-4.1', name: 'GPT-4.1' },
      { id: 'gpt-5', name: 'gpt-5' },
    ]);
  });

  test('a provider without a configured key is refused', async () => {
    await expect(h.core.llmSettings.listModels(ADMIN, 'groq')).rejects.toBeInstanceOf(ValidationError);
  });

  test('when the provider cannot be reached, a readable error names it and says why', async () => {
    h.llm.configure({
      providers: ['openai'],
      labels: { openai: 'OpenAI' },
      models: { openai: new Error('the provider answered 401 (check the API key)') },
    });

    const error = await h.core.llmSettings.listModels(ADMIN, 'openai').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ModelListError);
    expect((error as Error).message).toMatch(/from OpenAI: .*401/);
  });
});
