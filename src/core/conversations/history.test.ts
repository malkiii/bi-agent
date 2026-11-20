import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { NotFoundError, ValidationError } from '@/core';
import { createTestHarness, type TestHarness } from '@/core/testing';

const ADA = 'UADA';
const BOB = 'UBOB';
const BOT = 'UBOT';
const CHANNEL = 'CSALES';

let h: TestHarness;
beforeEach(async () => {
  h = await createTestHarness({ config: { slackTeamId: 'T1' } });
  for (const slackUserId of [ADA, BOB]) {
    await h.core.users.signIn({ slackUserId, slackTeamId: 'T1', name: slackUserId, email: null, image: null });
  }
});
afterEach(() => h.close());

async function webConversation(actor: string, prompt: string) {
  h.llm.script({ text: `Answer to ${prompt}` });
  const conversation = await h.core.conversations.startWeb(actor);
  await h.core.conversations.ask(actor, conversation.id, prompt);
  h.clock.advance(60_000);
  return conversation;
}

async function slackConversation(actor: string, ts: string, prompt: string) {
  h.llm.script({ text: `Answer to ${prompt}` });
  await h.core.slackBot.handlePrompt({ userId: actor, channel: CHANNEL, ts, text: `<@${BOT}> ${prompt}`, botUserId: BOT });
  h.clock.advance(60_000);
  const { conversations } = await h.core.conversations.history(actor, { source: 'slack' });
  return conversations[0]!;
}

describe('Conversation history', () => {
  test('lists only Conversations the person is a Participant in, newest first', async () => {
    const first = await webConversation(ADA, 'first');
    await webConversation(BOB, 'bob only');
    const slack = await slackConversation(ADA, '100.1', 'from slack');
    await h.core.conversations.startWeb(ADA); // no Prompt yet: not history

    const { conversations, hasNextPage } = await h.core.conversations.history(ADA);

    expect(conversations.map((c) => c.id)).toEqual([slack.id, first.id]);
    expect(conversations.map((c) => c.title)).toEqual(['from slack', 'first']);
    expect(hasNextPage).toBe(false);
  });

  test('filters by Source', async () => {
    const web = await webConversation(ADA, 'web one');
    const slack = await slackConversation(ADA, '100.1', 'slack one');

    expect((await h.core.conversations.history(ADA, { source: 'web' })).conversations.map((c) => c.id)).toEqual([web.id]);
    expect((await h.core.conversations.history(ADA, { source: 'slack' })).conversations.map((c) => c.id)).toEqual([slack.id]);
  });

  test('pages through older Conversations', async () => {
    const titles = ['one', 'two', 'three', 'four', 'five'];
    for (const t of titles) await webConversation(ADA, t);

    const page1 = await h.core.conversations.history(ADA, { pageSize: 2 });
    const page3 = await h.core.conversations.history(ADA, { pageSize: 2, page: 3 });

    expect(page1.conversations.map((c) => c.title)).toEqual(['five', 'four']);
    expect(page1).toMatchObject({ page: 1, hasNextPage: true });
    expect(page3.conversations.map((c) => c.title)).toEqual(['one']);
    expect(page3).toMatchObject({ page: 3, hasNextPage: false });
  });

  test('a non-Participant cannot open a Conversation', async () => {
    const web = await webConversation(ADA, 'private');
    const slack = await slackConversation(ADA, '100.1', 'thread');

    await expect(h.core.conversations.get(BOB, web.id)).rejects.toThrow(NotFoundError);
    await expect(h.core.conversations.get(BOB, slack.id)).rejects.toThrow(NotFoundError);
  });
});

describe('Forks', () => {
  test('a Participant forks a Slack Conversation into a new web Conversation with its history', async () => {
    const slack = await slackConversation(ADA, '100.1', 'north sales?');

    const fork = await h.core.conversations.fork(ADA, slack.id);

    expect(fork).toMatchObject({
      source: { kind: 'web' },
      title: 'north sales?',
      participants: [ADA],
      forkedFrom: { conversationId: slack.id },
    });
    const { messages } = await h.core.conversations.get(ADA, fork.id);
    expect(messages).toMatchObject([
      { kind: 'prompt', text: 'north sales?', authorSlackUserId: ADA },
      { kind: 'answer', answer: { blocks: [{ type: 'text', markdown: 'Answer to north sales?' }] } },
    ]);
    expect(await h.core.conversations.history(ADA, { source: 'web' })).toMatchObject({ conversations: [{ id: fork.id }] });
  });

  test('continuing the Fork gives the model the Slack history and leaves the Slack thread unchanged', async () => {
    const slack = await slackConversation(ADA, '100.1', 'north sales?');
    const slackMessagesBefore = h.slack.messages.length;
    const fork = await h.core.conversations.fork(ADA, slack.id);
    h.llm.script({ text: 'Still north.' });

    const answer = await h.core.conversations.ask(ADA, fork.id, 'and again?');

    expect(answer.status).toBe('complete');
    const prompt = JSON.stringify(h.llm.model.doStreamCalls.at(-1)?.prompt);
    expect(prompt).toContain('north sales?');
    expect(prompt).toContain('Answer to north sales?');
    const original = await h.core.conversations.get(ADA, slack.id);
    expect(original.messages).toHaveLength(2);
    expect(original.conversation.updatedAt).toEqual(slack.updatedAt);
    expect(h.slack.messages).toHaveLength(slackMessagesBefore);
  });

  test('only Participants can fork, and only Slack Conversations', async () => {
    const slack = await slackConversation(ADA, '100.1', 'thread');
    const web = await webConversation(ADA, 'web');

    await expect(h.core.conversations.fork(BOB, slack.id)).rejects.toThrow(NotFoundError);
    await expect(h.core.conversations.fork(ADA, web.id)).rejects.toThrow(ValidationError);
  });

  test('a Slack Conversation is not continued from the web: it has to be forked', async () => {
    const slack = await slackConversation(ADA, '100.1', 'thread');

    await expect(h.core.conversations.ask(ADA, slack.id, 'from the web')).rejects.toThrow(ValidationError);
  });
});

describe('reading one Answer', () => {
  test('Participants can read an Answer by its message id; others get NotFound', async () => {
    const web = await webConversation(ADA, 'numbers');
    const { messages } = await h.core.conversations.get(ADA, web.id);
    const answerId = messages.find((m) => m.kind === 'answer')!.id;

    await expect(h.core.conversations.getVisibleAnswer(ADA, answerId)).resolves.toMatchObject({ status: 'complete' });
    await expect(h.core.conversations.getVisibleAnswer(BOB, answerId)).rejects.toThrow(NotFoundError);
  });
});
