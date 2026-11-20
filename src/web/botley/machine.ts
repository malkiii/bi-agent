/**
 * Botley's state machine, pure so it can be tested without React.
 *
 * - `rest`: the page's resting mood (idle by default, `empty` on an empty page, `error` on an error page).
 * - `cue`: a temporary mood set by an app event (thinking, success, ...). It wins over `rest`
 *   until it expires (`DEFAULT_CUE_MS` or the caller's `forMs`) or is settled.
 * - An idle Botley with no activity for `SLEEP_AFTER_MS` shows `sleeping`; any activity wakes it.
 */
export type BotleyState = 'idle' | 'thinking' | 'success' | 'error' | 'empty' | 'sleeping';

export const BOTLEY_STATES: readonly BotleyState[] = ['idle', 'thinking', 'success', 'error', 'empty', 'sleeping'];

export const SLEEP_AFTER_MS = 120_000;

/** How long a cue shows when the caller gives no `forMs`. `null` = until settled. */
export const DEFAULT_CUE_MS: Record<BotleyState, number | null> = {
  idle: null,
  thinking: null,
  success: 2_500,
  error: 4_000,
  empty: null,
  sleeping: null,
};

export interface BotleyMachine {
  rest: BotleyState;
  cue: { state: BotleyState; until: number | null } | null;
  lastActivityAt: number;
}

export type BotleyEvent =
  /** Show `state` for `forMs` (default `DEFAULT_CUE_MS[state]`; `null` = until settled). */
  | { type: 'cue'; state: BotleyState; now: number; forMs?: number | null }
  /** Drop the current cue and go back to the resting state (counts as activity). */
  | { type: 'settle'; now: number }
  /** Change the page's resting state. */
  | { type: 'rest'; state: BotleyState }
  /** The person did something (pointer, keyboard, scroll, focus). Wakes Botley. */
  | { type: 'activity'; now: number };

export function initialBotley(now: number, rest: BotleyState = 'idle'): BotleyMachine {
  return { rest, cue: null, lastActivityAt: now };
}

export function botleyReducer(machine: BotleyMachine, event: BotleyEvent): BotleyMachine {
  switch (event.type) {
    case 'cue': {
      const forMs = event.forMs === undefined ? DEFAULT_CUE_MS[event.state] : event.forMs;
      const until = forMs === null ? null : event.now + forMs;
      return { ...machine, cue: { state: event.state, until }, lastActivityAt: event.now };
    }
    case 'settle':
      return { ...machine, cue: null, lastActivityAt: event.now };
    case 'rest':
      return { ...machine, rest: event.state };
    case 'activity':
      return { ...machine, lastActivityAt: event.now };
  }
}

export function visibleBotleyState(machine: BotleyMachine, now: number): BotleyState {
  const { cue } = machine;
  if (cue && (cue.until === null || now < cue.until)) return cue.state;
  if (machine.rest === 'idle' && now - machine.lastActivityAt >= SLEEP_AFTER_MS) return 'sleeping';
  return machine.rest;
}
