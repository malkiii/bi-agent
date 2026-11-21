import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createAppCore, ForbiddenError, ValidationError } from '@/core';
import { createTestHarness, MockLlm, type TestHarness } from '@/core/testing';

const ADMIN = 'UADMIN';
const MEMBER = 'UMEMBER';

let h: TestHarness;
beforeEach(async () => {
  h = await createTestHarness({ config: { slackTeamId: 'T1', adminSlackUserIds: [ADMIN] } });
  for (const slackUserId of [ADMIN, MEMBER]) {
    await h.core.users.signIn({ slackUserId, slackTeamId: 'T1', name: slackUserId, email: null, image: null });
  }
  h.llm.configure({ providers: ['anthropic', 'openai'], defaultChoice: { provider: 'anthropic', model: 'claude-default' } });
});
afterEach(() => h.close());

async function askSomething() {
  h.llm.script({ text: 'Hi' });
  const conversation = await h.core.conversations.startWeb(MEMBER);
  await h.core.conversations.ask(MEMBER, conversation.id, 'Hello?');
}

describe('switching the LLM in admin settings', () => {
  test('a new Prompt uses the provider and model an admin chose', async () => {
    await h.core.llmSettings.set(ADMIN, { provider: 'openai', model: 'gpt-chosen' });

    await askSomething();

    expect(h.llm.choices.at(-1)).toEqual({ provider: 'openai', model: 'gpt-chosen' });
  });

  test('another process sees the change on its next Prompt, without a restart', async () => {
    const llm = new MockLlm();
    llm.configure({ providers: ['anthropic', 'openai'], defaultChoice: { provider: 'anthropic', model: 'claude-default' } });
    const worker = createAppCore({ db: h.db, clock: h.clock, slack: h.slack, llm, drivers: {}, config: h.config });
    llm.script({ text: 'Hi' });
    const before = await worker.conversations.startWeb(MEMBER);
    await worker.conversations.ask(MEMBER, before.id, 'Hello?');

    await h.core.llmSettings.set(ADMIN, { provider: 'openai', model: 'gpt-chosen' });
    await worker.conversations.ask(MEMBER, before.id, 'And now?');

    expect(llm.choices).toEqual([
      { provider: 'anthropic', model: 'claude-default' },
      { provider: 'openai', model: 'gpt-chosen' },
    ]);
  });

  test('until an admin chooses, Prompts use the environment default', async () => {
    await askSomething();

    expect(h.llm.choices.at(-1)).toEqual({ provider: 'anthropic', model: 'claude-default' });
    expect(await h.core.llmSettings.get(ADMIN)).toEqual({
      active: { provider: 'anthropic', model: 'claude-default' },
      source: 'environment',
      providers: ['anthropic', 'openai'],
    });
  });

  test('admins see only the providers whose keys are configured, and the active choice', async () => {
    const view = await h.core.llmSettings.set(ADMIN, { provider: 'openai', model: ' gpt-chosen ' });

    expect(view).toEqual({ active: { provider: 'openai', model: 'gpt-chosen' }, source: 'admin', providers: ['anthropic', 'openai'] });
  });

  test('a provider without a configured key, or an empty model, is refused', async () => {
    await expect(h.core.llmSettings.set(ADMIN, { provider: 'groq', model: 'llama' })).rejects.toMatchObject({
      fieldErrors: { provider: expect.any(String) },
    });
    await expect(h.core.llmSettings.set(ADMIN, { provider: 'openai', model: '  ' })).rejects.toBeInstanceOf(ValidationError);

    expect((await h.core.llmSettings.get(ADMIN)).source).toBe('environment');
  });

  test('members can neither see nor change the setting', async () => {
    await expect(h.core.llmSettings.get(MEMBER)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(h.core.llmSettings.set(MEMBER, { provider: 'openai', model: 'gpt-chosen' })).rejects.toBeInstanceOf(ForbiddenError);

    expect((await h.core.llmSettings.get(ADMIN)).source).toBe('environment');
  });

  test('when the chosen provider loses its key, Prompts fall back to the environment default', async () => {
    await h.core.llmSettings.set(ADMIN, { provider: 'openai', model: 'gpt-chosen' });
    h.llm.configure({ providers: ['anthropic'], defaultChoice: { provider: 'anthropic', model: 'claude-default' } });

    await askSomething();

    expect(h.llm.choices.at(-1)).toEqual({ provider: 'anthropic', model: 'claude-default' });
  });

  test('with no LLM configured at all, the Answer fails instead of crashing', async () => {
    h.llm.configure({ providers: [], defaultChoice: null });
    h.llm.script({ text: 'Hi' });
    const conversation = await h.core.conversations.startWeb(MEMBER);

    const answer = await h.core.conversations.ask(MEMBER, conversation.id, 'Hello?');

    expect(answer.status).toBe('failed');
  });
});
