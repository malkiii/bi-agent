import { expect, test } from 'vitest';
import { botleyReducer, initialBotley, visibleBotleyState } from './machine';

const T0 = 1_000_000;

test('Botley starts in the resting state of the page', () => {
  expect(visibleBotleyState(initialBotley(T0), T0)).toBe('idle');
  expect(visibleBotleyState(initialBotley(T0, 'empty'), T0)).toBe('empty');
});

test('thinking lasts until it is settled, then Botley returns to rest', () => {
  let m = botleyReducer(initialBotley(T0), { type: 'cue', state: 'thinking', now: T0 });
  expect(visibleBotleyState(m, T0 + 10 * 60_000)).toBe('thinking');

  m = botleyReducer(m, { type: 'settle', now: T0 + 10 * 60_000 });
  expect(visibleBotleyState(m, T0 + 10 * 60_000 + 1)).toBe('idle');
});

test('success and error flash briefly, then Botley returns to rest', () => {
  const start = initialBotley(T0, 'empty');
  const success = botleyReducer(start, { type: 'cue', state: 'success', now: T0 });
  expect(visibleBotleyState(success, T0 + 2_499)).toBe('success');
  expect(visibleBotleyState(success, T0 + 2_500)).toBe('empty');

  const error = botleyReducer(start, { type: 'cue', state: 'error', now: T0 });
  expect(visibleBotleyState(error, T0 + 3_999)).toBe('error');
  expect(visibleBotleyState(error, T0 + 4_000)).toBe('empty');
});

test('a cue can set its own duration, or last until settled', () => {
  const short = botleyReducer(initialBotley(T0), { type: 'cue', state: 'thinking', now: T0, forMs: 1_000 });
  expect(visibleBotleyState(short, T0 + 999)).toBe('thinking');
  expect(visibleBotleyState(short, T0 + 1_000)).toBe('idle');

  const pinned = botleyReducer(initialBotley(T0), { type: 'cue', state: 'error', now: T0, forMs: null });
  expect(visibleBotleyState(pinned, T0 + 60_000)).toBe('error');
});

test('a page can change the resting state, and a running cue stays on top', () => {
  let m = botleyReducer(initialBotley(T0), { type: 'cue', state: 'thinking', now: T0 });
  m = botleyReducer(m, { type: 'rest', state: 'empty' });
  expect(visibleBotleyState(m, T0)).toBe('thinking');

  m = botleyReducer(m, { type: 'settle', now: T0 });
  expect(visibleBotleyState(m, T0)).toBe('empty');
});

test('an idle Botley falls asleep after two quiet minutes and wakes on activity', () => {
  let m = initialBotley(T0);
  expect(visibleBotleyState(m, T0 + 119_999)).toBe('idle');
  expect(visibleBotleyState(m, T0 + 120_000)).toBe('sleeping');

  m = botleyReducer(m, { type: 'activity', now: T0 + 200_000 });
  expect(visibleBotleyState(m, T0 + 200_000)).toBe('idle');
  expect(visibleBotleyState(m, T0 + 320_000)).toBe('sleeping');
});

test('Botley never dozes off while busy or showing something other than idle', () => {
  const thinking = botleyReducer(initialBotley(T0), { type: 'cue', state: 'thinking', now: T0 });
  expect(visibleBotleyState(thinking, T0 + 10 * 60_000)).toBe('thinking');

  expect(visibleBotleyState(initialBotley(T0, 'empty'), T0 + 10 * 60_000)).toBe('empty');
});

test('cues and settling count as activity', () => {
  let m = botleyReducer(initialBotley(T0), { type: 'cue', state: 'success', now: T0 + 100_000 });
  expect(visibleBotleyState(m, T0 + 150_000)).toBe('idle');
  m = botleyReducer(m, { type: 'settle', now: T0 + 100_000 });
  expect(visibleBotleyState(m, T0 + 219_999)).toBe('idle');
  expect(visibleBotleyState(m, T0 + 220_000)).toBe('sleeping');
});
