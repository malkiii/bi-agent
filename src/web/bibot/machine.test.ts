import { expect, test } from 'vitest';
import { bibotReducer, initialBIBot, visibleBIBotState } from './machine';

const T0 = 1_000_000;

test('BIBot starts in the resting state of the page', () => {
  expect(visibleBIBotState(initialBIBot(T0), T0)).toBe('idle');
  expect(visibleBIBotState(initialBIBot(T0, 'empty'), T0)).toBe('empty');
});

test('thinking lasts until it is settled, then BIBot returns to rest', () => {
  let m = bibotReducer(initialBIBot(T0), { type: 'cue', state: 'thinking', now: T0 });
  expect(visibleBIBotState(m, T0 + 10 * 60_000)).toBe('thinking');

  m = bibotReducer(m, { type: 'settle', now: T0 + 10 * 60_000 });
  expect(visibleBIBotState(m, T0 + 10 * 60_000 + 1)).toBe('idle');
});

test('success and error flash briefly, then BIBot returns to rest', () => {
  const start = initialBIBot(T0, 'empty');
  const success = bibotReducer(start, { type: 'cue', state: 'success', now: T0 });
  expect(visibleBIBotState(success, T0 + 2_499)).toBe('success');
  expect(visibleBIBotState(success, T0 + 2_500)).toBe('empty');

  const error = bibotReducer(start, { type: 'cue', state: 'error', now: T0 });
  expect(visibleBIBotState(error, T0 + 3_999)).toBe('error');
  expect(visibleBIBotState(error, T0 + 4_000)).toBe('empty');
});

test('a cue can set its own duration, or last until settled', () => {
  const short = bibotReducer(initialBIBot(T0), { type: 'cue', state: 'thinking', now: T0, forMs: 1_000 });
  expect(visibleBIBotState(short, T0 + 999)).toBe('thinking');
  expect(visibleBIBotState(short, T0 + 1_000)).toBe('idle');

  const pinned = bibotReducer(initialBIBot(T0), { type: 'cue', state: 'error', now: T0, forMs: null });
  expect(visibleBIBotState(pinned, T0 + 60_000)).toBe('error');
});

test('a page can change the resting state, and a running cue stays on top', () => {
  let m = bibotReducer(initialBIBot(T0), { type: 'cue', state: 'thinking', now: T0 });
  m = bibotReducer(m, { type: 'rest', state: 'empty' });
  expect(visibleBIBotState(m, T0)).toBe('thinking');

  m = bibotReducer(m, { type: 'settle', now: T0 });
  expect(visibleBIBotState(m, T0)).toBe('empty');
});

test('an idle BIBot falls asleep after two quiet minutes and wakes on activity', () => {
  let m = initialBIBot(T0);
  expect(visibleBIBotState(m, T0 + 119_999)).toBe('idle');
  expect(visibleBIBotState(m, T0 + 120_000)).toBe('sleeping');

  m = bibotReducer(m, { type: 'activity', now: T0 + 200_000 });
  expect(visibleBIBotState(m, T0 + 200_000)).toBe('idle');
  expect(visibleBIBotState(m, T0 + 320_000)).toBe('sleeping');
});

test('BIBot never dozes off while busy or showing something other than idle', () => {
  const thinking = bibotReducer(initialBIBot(T0), { type: 'cue', state: 'thinking', now: T0 });
  expect(visibleBIBotState(thinking, T0 + 10 * 60_000)).toBe('thinking');

  expect(visibleBIBotState(initialBIBot(T0, 'empty'), T0 + 10 * 60_000)).toBe('empty');
});

test('cues and settling count as activity', () => {
  let m = bibotReducer(initialBIBot(T0), { type: 'cue', state: 'success', now: T0 + 100_000 });
  expect(visibleBIBotState(m, T0 + 150_000)).toBe('idle');
  m = bibotReducer(m, { type: 'settle', now: T0 + 100_000 });
  expect(visibleBIBotState(m, T0 + 219_999)).toBe('idle');
  expect(visibleBIBotState(m, T0 + 220_000)).toBe('sleeping');
});
