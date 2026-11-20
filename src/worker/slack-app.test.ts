import { describe, expect, test } from 'vitest';
import { promptFromDirectMessage, promptFromMention } from './slack-app';

const BOT = 'UBOT';

describe('Slack events that become Prompts', () => {
  test('an @mention in a channel thread', () => {
    expect(
      promptFromMention({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT> hi', ts: '2.0', thread_ts: '1.0' }, BOT),
    ).toEqual({ userId: 'U1', channel: 'C1', ts: '2.0', threadTs: '1.0', text: '<@UBOT> hi', botUserId: BOT });
  });

  test('a plain DM, without a mention', () => {
    expect(promptFromDirectMessage({ channel: 'D1', channel_type: 'im', user: 'U1', text: 'hi', ts: '1.0' }, BOT)).toEqual({
      userId: 'U1',
      channel: 'D1',
      ts: '1.0',
      text: 'hi',
      botUserId: BOT,
    });
  });

  test.each([
    ['a channel message (channels only answer @mentions)', { channel: 'C1', channel_type: 'channel', user: 'U1', ts: '1.0' }],
    ['an edit', { channel: 'D1', channel_type: 'im', subtype: 'message_changed', ts: '1.0' }],
    ['a bot message', { channel: 'D1', channel_type: 'im', user: 'U2', bot_id: 'B1', ts: '1.0' }],
    ['the bot itself', { channel: 'D1', channel_type: 'im', user: BOT, ts: '1.0' }],
  ])('ignores %s', (_, event) => {
    expect(promptFromDirectMessage(event, BOT)).toBeNull();
  });
});
