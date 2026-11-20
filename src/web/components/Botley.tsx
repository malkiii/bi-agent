import styles from './Botley.module.css';

/** Botley's moods. Only `idle` is animated so far; the others arrive with their features. */
export type BotleyState = 'idle' | 'thinking' | 'success' | 'error' | 'empty' | 'sleeping';

export function Botley({ state = 'idle', size = 160 }: { state?: BotleyState; size?: number }) {
  return (
    <svg
      className={styles.botley}
      data-state={state}
      width={size}
      height={size}
      viewBox="0 0 160 160"
      role="img"
      aria-label={`Botley is ${state}`}
    >
      <g className={styles.body}>
        <line x1="80" y1="14" x2="80" y2="34" stroke="#111" strokeWidth="4" />
        <circle className={styles.antenna} cx="80" cy="12" r="8" fill="var(--color-pink)" stroke="#111" strokeWidth="3" />
        <rect x="28" y="34" width="104" height="84" rx="14" fill="var(--color-yellow)" stroke="#111" strokeWidth="4" />
        <rect x="42" y="50" width="76" height="44" rx="8" fill="#fff" stroke="#111" strokeWidth="3" />
        <g className={styles.eyes}>
          <rect x="58" y="62" width="10" height="16" rx="5" fill="#111" />
          <rect x="92" y="62" width="10" height="16" rx="5" fill="#111" />
        </g>
        <path d="M68 104 Q80 112 92 104" fill="none" stroke="#111" strokeWidth="4" strokeLinecap="round" />
        <rect x="16" y="64" width="12" height="28" rx="4" fill="var(--color-cyan)" stroke="#111" strokeWidth="3" />
        <rect x="132" y="64" width="12" height="28" rx="4" fill="var(--color-cyan)" stroke="#111" strokeWidth="3" />
      </g>
      <ellipse className={styles.shadow} cx="80" cy="148" rx="40" ry="6" fill="#111" opacity="0.2" />
    </svg>
  );
}
