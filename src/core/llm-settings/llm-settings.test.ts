import { afterEach, beforeEach, expect, test } from 'vitest';
import { createAppCore } from '@/core';
import { createTestHarness, type TestHarness } from '@/core/testing';
import { builtInDrivers } from '@/drivers';

const TEAM = 'T0TEAM';

let h: TestHarness;
beforeEach(async () => {
  h = await createTestHarness({ config: { slackTeamId: TEAM, adminSlackUserIds: ['UADMIN'] } });
  h.llm.configure({ default: { provider: 'anthropic', model: 'claude-env' }, providers: ['anthropic', 'openai'] });
  for (const id of ['UADMIN', 'UBOB']) {
    await h.core.users.signIn({ slackUserId: id, slackTeamId: TEAM, name: id, email: null, image: null });
  }
});
afterEach(() => h.close());

test('admins see the configured providers and the environment default as active', async () => {
  expect(await h.core.llmSettings.get('UADMIN')).toEqual({
    providers: ['anthropic', 'openai'],
    default: { provider: 'anthropic', model: 'claude-env' },
    active: { provider: 'anthropic', model: 'claude-env' },
    overridden: false,
  });
});

async function askSomething() {
  h.llm.script({ text: 'Hi' });
  const conversation = await h.core.conversations.startWeb('UBOB');
  await h.core.conversations.ask('UBOB', conversation.id, 'Hello?');
}

test('Prompts use the environment default until an admin chooses otherwise', async () => {
  await askSomething();

  expect(h.llm.choices.at(-1)).toEqual({ provider: 'anthropic', model: 'claude-env' });
});

test("an admin's choice applies to the next Prompt, and resetting restores the default", async () => {
  const saved = await h.core.llmSettings.set('UADMIN', { provider: 'openai', model: 'gpt-x' });
  expect(saved).toMatchObject({ active: { provider: 'openai', model: 'gpt-x' }, overridden: true });

  await askSomething();
  expect(h.llm.choices.at(-1)).toEqual({ provider: 'openai', model: 'gpt-x' });

  const reset = await h.core.llmSettings.reset('UADMIN');
  expect(reset).toMatchObject({ active: { provider: 'anthropic', model: 'claude-env' }, overridden: false });

  await askSomething();
  expect(h.llm.choices.at(-1)).toEqual({ provider: 'anthropic', model: 'claude-env' });
});

test('a choice saved by another process (another App Core on the same database) applies without a restart', async () => {
  const otherProcess = createAppCore({
    db: h.db,
    clock: h.clock,
    slack: h.slack,
    llm: h.llm,
    drivers: builtInDrivers,
    config: h.config,
  });

  await otherProcess.llmSettings.set('UADMIN', { provider: 'openai', model: 'gpt-x' });
  await askSomething();

  expect(h.llm.choices.at(-1)).toEqual({ provider: 'openai', model: 'gpt-x' });
});

test('only providers with configured keys can be chosen, and the model is required', async () => {
  await expect(h.core.llmSettings.set('UADMIN', { provider: 'groq', model: 'llama' })).rejects.toMatchObject({
    code: 'invalid_input',
    fieldErrors: { provider: expect.any(String) },
  });
  await expect(h.core.llmSettings.set('UADMIN', { provider: 'openai', model: '  ' })).rejects.toMatchObject({
    code: 'invalid_input',
    fieldErrors: { model: expect.any(String) },
  });
  expect(await h.core.llmSettings.get('UADMIN')).toMatchObject({ overridden: false });
});

test('a choice whose provider loses its key falls back to the default', async () => {
  await h.core.llmSettings.set('UADMIN', { provider: 'openai', model: 'gpt-x' });
  h.llm.configure({ default: { provider: 'anthropic', model: 'claude-env' }, providers: ['anthropic'] });

  expect(await h.core.llmSettings.get('UADMIN')).toMatchObject({
    active: { provider: 'anthropic', model: 'claude-env' },
    overridden: false,
  });
});

test('members cannot see or change the LLM settings', async () => {
  await expect(h.core.llmSettings.get('UBOB')).rejects.toMatchObject({ code: 'forbidden' });
  await expect(h.core.llmSettings.set('UBOB', { provider: 'openai', model: 'gpt-x' })).rejects.toMatchObject({
    code: 'forbidden',
  });
  await expect(h.core.llmSettings.reset('UBOB')).rejects.toMatchObject({ code: 'forbidden' });

  await askSomething();
  expect(h.llm.choices.at(-1)).toEqual({ provider: 'anthropic', model: 'claude-env' });
});
