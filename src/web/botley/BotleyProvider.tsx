'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import { botleyReducer, initialBotley, visibleBotleyState, type BotleyState } from './machine';

export interface BotleyControls {
  /** What Botley shows right now. */
  state: BotleyState;
  /** The page's resting mood (what Botley returns to). */
  rest: BotleyState;
  /**
   * Show a mood because something happened. `success` and `error` flash and return to rest on
   * their own; `thinking` (and the rest) lasts until `settleBotley()` unless `forMs` is given.
   */
  setBotleyState(state: BotleyState, options?: { forMs?: number | null }): void;
  /** End the current mood (e.g. the answer arrived) and go back to the page's resting state. */
  settleBotley(): void;
  /** Set the page's resting mood. Prefer `<BotleyRest>` from server components. */
  setBotleyRest(state: BotleyState): void;
}

const NOOP: BotleyControls = {
  state: 'idle',
  rest: 'idle',
  setBotleyState: () => {},
  settleBotley: () => {},
  setBotleyRest: () => {},
};

const BotleyContext = createContext<BotleyControls>(NOOP);

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'focus'] as const;
const TICK_MS = 1_000;

/** Holds the Botley store for the whole page. Mounted once in the root layout. */
export function BotleyProvider({ children }: { children: ReactNode }) {
  const [machine, dispatch] = useReducer(botleyReducer, 0, (t) => initialBotley(t));
  const [now, setNow] = useState(0);

  useEffect(() => {
    // Start the activity clock on the client (the server render always shows the resting state).
    dispatch({ type: 'activity', now: Date.now() });
    const tick = window.setInterval(() => setNow(Date.now()), TICK_MS);
    let last = 0;
    const onActivity = () => {
      const t = Date.now();
      if (t - last < TICK_MS) return;
      last = t;
      dispatch({ type: 'activity', now: t });
      setNow(t);
    };
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, onActivity, { passive: true, capture: true });
    return () => {
      window.clearInterval(tick);
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onActivity, { capture: true });
    };
  }, []);

  const setBotleyState = useCallback<BotleyControls['setBotleyState']>((state, options) => {
    const t = Date.now();
    dispatch({ type: 'cue', state, now: t, forMs: options?.forMs });
    setNow(t);
  }, []);
  const settleBotley = useCallback(() => {
    const t = Date.now();
    dispatch({ type: 'settle', now: t });
    setNow(t);
  }, []);
  const setBotleyRest = useCallback((state: BotleyState) => dispatch({ type: 'rest', state }), []);

  // Before the first client tick `now` is 0: show the resting state, never a time-based mood.
  const state = now === 0 ? (machine.cue?.state ?? machine.rest) : visibleBotleyState(machine, now);
  const value = useMemo(
    () => ({ state, rest: machine.rest, setBotleyState, settleBotley, setBotleyRest }),
    [state, machine.rest, setBotleyState, settleBotley, setBotleyRest],
  );
  return <BotleyContext value={value}>{children}</BotleyContext>;
}

/** Read or drive Botley from any client component. Without a provider it is a quiet no-op. */
export function useBotley(): BotleyControls {
  return useContext(BotleyContext);
}

/** Declares the page's resting mood (e.g. `empty`, `error`). Resets to idle when the page unmounts. */
export function BotleyRest({ state }: { state: BotleyState }) {
  const { setBotleyRest } = useBotley();
  useEffect(() => {
    setBotleyRest(state);
    return () => setBotleyRest('idle');
  }, [state, setBotleyRest]);
  return null;
}

/** Fires a one-off mood when it mounts (e.g. `success` right after sign-in). */
export function BotleyCue({ state, forMs }: { state: BotleyState; forMs?: number | null }) {
  const { setBotleyState } = useBotley();
  useEffect(() => {
    setBotleyState(state, { forMs });
  }, [state, forMs, setBotleyState]);
  return null;
}
