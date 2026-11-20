import { expect, test } from 'vitest';
import { createNdjsonParser, type ChatStreamEvent } from './wire';

test('events split across network chunks are reassembled line by line', () => {
  const events: ChatStreamEvent[] = [];
  const parser = createNdjsonParser((e) => events.push(e));

  parser.push('{"type":"conversation","id":"c1"}\n{"type":"progr');
  parser.push('ess","label":"Querying…"}\n');
  parser.push('{"type":"error","message":"x"}');
  parser.end();

  expect(events).toEqual([
    { type: 'conversation', id: 'c1' },
    { type: 'progress', label: 'Querying…' },
    { type: 'error', message: 'x' },
  ]);
});
