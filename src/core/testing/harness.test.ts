import { generateText } from 'ai';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createTestHarness, type TestHarness } from '.';

let h: TestHarness;
beforeEach(async () => {
  h = await createTestHarness();
});
afterEach(() => h.close());

test('scripted LLM turns are returned in order', async () => {
  h.llm.script({ text: 'first' }, { text: 'second' });
  const model = await h.llm.getModel();

  expect((await generateText({ model, prompt: 'a' })).text).toBe('first');
  expect((await generateText({ model, prompt: 'b' })).text).toBe('second');
});

test('in-memory Slack records posts, updates and reactions', async () => {
  const ref = await h.slack.postMessage({ channel: 'C1', threadTs: '1.0', text: 'thinking…' });
  await h.slack.updateMessage(ref, { text: 'done' });
  await h.slack.addReaction(ref, 'eyes');

  expect(h.slack.thread('C1', '1.0')).toMatchObject([{ text: 'done', history: [{ text: 'thinking…' }] }]);
  expect(h.slack.reactions).toEqual([{ ...ref, emoji: 'eyes' }]);
});
