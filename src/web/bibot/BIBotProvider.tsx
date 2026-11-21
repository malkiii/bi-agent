'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import { bibotReducer, initialBIBot, visibleBIBotState, type BIBotState } from './machine';

export interface BIBotControls {
  /** What BIBot shows right now. */
  state: BIBotState;
  /** The page's resting mood (what BIBot returns to). */
  rest: BIBotState;
  /**
   * Show a mood because something happened. `success` and `error` flash and return to rest on
   * their own; `thinking` (and the rest) lasts until `settleBIBot()` unless `forMs` is given.
   */
  setBIBotState(state: BIBotState, options?: { forMs?: number | null }): void;
  /** End the current mood (e.g. the answer arrived) and go back to the page's resting state. */
  settleBIBot(): void;
  /** Set the page's resting mood. Prefer `<BIBotRest>` from server components. */
  setBIBotRest(state: BIBotState): void;
}

const NOOP: BIBotControls = {
  state: 'idle',
  rest: 'idle',
  setBIBotState: () => {},
  settleBIBot: () => {},
  setBIBotRest: () => {},
};

const BIBotContext = createContext<BIBotControls>(NOOP);

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'focus'] as const;
const TICK_MS = 1_000;

/** Holds the BIBot store for the whole page. Mounted once in the root layout. */
export function BIBotProvider({ children }: { children: ReactNode }) {
  const [machine, dispatch] = useReducer(bibotReducer, 0, (t) => initialBIBot(t));
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

  const setBIBotState = useCallback<BIBotControls['setBIBotState']>((state, options) => {
    const t = Date.now();
    dispatch({ type: 'cue', state, now: t, forMs: options?.forMs });
    setNow(t);
  }, []);
  const settleBIBot = useCallback(() => {
    const t = Date.now();
    dispatch({ type: 'settle', now: t });
    setNow(t);
  }, []);
  const setBIBotRest = useCallback((state: BIBotState) => dispatch({ type: 'rest', state }), []);

  // Before the first client tick `now` is 0: show the resting state, never a time-based mood.
  const state = now === 0 ? (machine.cue?.state ?? machine.rest) : visibleBIBotState(machine, now);
  const value = useMemo(
    () => ({ state, rest: machine.rest, setBIBotState, settleBIBot, setBIBotRest }),
    [state, machine.rest, setBIBotState, settleBIBot, setBIBotRest],
  );
  return <BIBotContext value={value}>{children}</BIBotContext>;
}

/** Read or drive BIBot from any client component. Without a provider it is a quiet no-op. */
export function useBIBot(): BIBotControls {
  return useContext(BIBotContext);
}

/** Declares the page's resting mood (e.g. `empty`, `error`). Resets to idle when the page unmounts. */
export function BIBotRest({ state }: { state: BIBotState }) {
  const { setBIBotRest } = useBIBot();
  useEffect(() => {
    setBIBotRest(state);
    return () => setBIBotRest('idle');
  }, [state, setBIBotRest]);
  return null;
}

/** Fires a one-off mood when it mounts (e.g. `success` right after sign-in). */
export function BIBotCue({ state, forMs }: { state: BIBotState; forMs?: number | null }) {
  const { setBIBotState } = useBIBot();
  useEffect(() => {
    setBIBotState(state, { forMs });
  }, [state, forMs, setBIBotState]);
  return null;
}
