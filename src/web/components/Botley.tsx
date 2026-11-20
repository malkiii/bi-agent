'use client';

import { useEffect } from 'react';
import { useBotley } from '@/web/botley/BotleyProvider';
import type { BotleyState } from '@/web/botley/machine';
import styles from './Botley.module.css';

export type { BotleyState } from '@/web/botley/machine';

const LABELS: Record<BotleyState, string> = {
  idle: 'Botley is waiting',
  thinking: 'Botley is thinking',
  success: 'Botley is happy',
  error: 'Botley hit a problem',
  empty: 'Botley found nothing here',
  sleeping: 'Botley is asleep',
};

/** Line colour inside Botley's yellow body. It stays dark in both themes, like the button text. */
const LINE = 'var(--botley-line)';

/**
 * Botley, the animated mascot. It follows the page's Botley store (`useBotley`), so app events
 * can change its mood. `rest` declares this page's resting mood (e.g. `empty`) and renders it on
 * the server too. `state` pins a fixed mood that events can't change.
 */
export function Botley({ state, rest, size = 160 }: { state?: BotleyState; rest?: BotleyState; size?: number }) {
  const live = useBotley();
  const { setBotleyRest } = live;
  useEffect(() => {
    if (!rest) return;
    setBotleyRest(rest);
    return () => setBotleyRest('idle');
  }, [rest, setBotleyRest]);
  // The store shows a cue or sleep when its mood differs from its rest; otherwise show our rest.
  const mood = state ?? (live.state !== live.rest ? live.state : (rest ?? live.state));
  return (
    <svg
      className={styles.botley}
      data-state={mood}
      width={size}
      height={size}
      viewBox="0 0 160 160"
      role="img"
      aria-label={LABELS[mood]}
    >
      <g className={styles.body}>
        <line x1="80" y1="14" x2="80" y2="34" stroke="var(--color-ink)" strokeWidth="4" />
        <circle className={styles.antenna} cx="80" cy="12" r="8" stroke={LINE} strokeWidth="3" />
        <rect x="28" y="34" width="104" height="84" rx="14" fill="var(--color-yellow)" stroke={LINE} strokeWidth="4" />
        <rect className={styles.arm} x="16" y="64" width="12" height="28" rx="4" fill="var(--color-cyan)" stroke={LINE} strokeWidth="3" />
        <rect className={`${styles.arm} ${styles.armRight}`} x="132" y="64" width="12" height="28" rx="4" fill="var(--color-cyan)" stroke={LINE} strokeWidth="3" />
        <rect x="42" y="50" width="76" height="44" rx="8" fill="var(--botley-screen)" stroke={LINE} strokeWidth="3" />
        <g className={styles.eyes}>
          <Eyes mood={mood} />
        </g>
        <Mouth mood={mood} />
      </g>
      <ellipse className={styles.shadow} cx="80" cy="148" rx="40" ry="6" fill="var(--color-ink)" opacity="0.2" />
      <Extras mood={mood} />
    </svg>
  );
}

function Eyes({ mood }: { mood: BotleyState }) {
  switch (mood) {
    case 'success':
      return (
        <g fill="none" stroke={LINE} strokeWidth="4" strokeLinecap="round">
          <path d="M56 76 L63 68 L70 76" />
          <path d="M90 76 L97 68 L104 76" />
        </g>
      );
    case 'error':
      return (
        <g stroke={LINE} strokeWidth="4" strokeLinecap="round">
          <path d="M57 64 L69 76 M69 64 L57 76" />
          <path d="M91 64 L103 76 M103 64 L91 76" />
        </g>
      );
    case 'sleeping':
      return (
        <g stroke={LINE} strokeWidth="4" strokeLinecap="round">
          <path d="M56 72 H70" />
          <path d="M90 72 H104" />
        </g>
      );
    case 'empty':
      return (
        <g fill={LINE}>
          <circle cx="63" cy="72" r="4" />
          <circle cx="97" cy="72" r="4" />
        </g>
      );
    default:
      return (
        <g fill={LINE}>
          <rect x="58" y="62" width="10" height="16" rx="5" />
          <rect x="92" y="62" width="10" height="16" rx="5" />
        </g>
      );
  }
}

function Mouth({ mood }: { mood: BotleyState }) {
  const common = { fill: 'none', stroke: LINE, strokeWidth: 4, strokeLinecap: 'round' as const };
  switch (mood) {
    case 'success':
      return <path d="M62 102 Q80 118 98 102" {...common} />;
    case 'error':
      return <path d="M68 110 Q80 102 92 110" {...common} />;
    case 'thinking':
      return <path className={styles.mouthThinking} d="M70 106 H90" {...common} />;
    case 'empty':
      return <circle cx="80" cy="106" r="4" {...common} strokeWidth={3} />;
    case 'sleeping':
      return <path d="M74 106 Q80 109 86 106" {...common} strokeWidth={3} />;
    default:
      return <path d="M68 104 Q80 112 92 104" {...common} />;
  }
}

function Extras({ mood }: { mood: BotleyState }) {
  const text = { fill: 'var(--color-ink)', fontFamily: 'var(--font-mono)', fontWeight: 700 };
  switch (mood) {
    case 'thinking':
      return (
        <g className={styles.dots} fill="var(--color-cyan)" stroke={LINE} strokeWidth="2">
          <circle cx="112" cy="20" r="5" />
          <circle cx="128" cy="14" r="5" />
          <circle cx="144" cy="8" r="5" />
        </g>
      );
    case 'success':
      return (
        <g className={styles.sparkles} fill="var(--color-lime)" stroke={LINE} strokeWidth="2">
          <path d="M18 22 l4 8 8 4 -8 4 -4 8 -4 -8 -8 -4 8 -4 z" />
          <path d="M138 26 l3 6 6 3 -6 3 -3 6 -3 -6 -6 -3 6 -3 z" />
        </g>
      );
    case 'empty':
      return (
        <text className={styles.question} x="122" y="30" fontSize="28" {...text}>
          ?
        </text>
      );
    case 'sleeping':
      return (
        <g className={styles.zzz} {...text}>
          <text x="112" y="34" fontSize="14">
            z
          </text>
          <text x="124" y="22" fontSize="18">
            z
          </text>
          <text x="138" y="10" fontSize="22">
            Z
          </text>
        </g>
      );
    default:
      return null;
  }
}
