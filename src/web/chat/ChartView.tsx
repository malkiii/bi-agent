'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChartBlock } from '@/core';
import { chartViewSpec, DARK_CHART_PALETTE, LIGHT_CHART_PALETTE, type ChartPalette } from '@/core/charts/chart';
import styles from './chat.module.css';

/**
 * A Chart Result Block drawn with vega-embed in the app theme. Colours come from the CSS
 * tokens, so it follows the light/dark theme and redraws when the theme changes.
 */
export function ChartView({ block }: { block: ChartBlock }) {
  const ref = useRef<HTMLDivElement>(null);
  const palette = useChartPalette();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    let finalize: (() => void) | undefined;
    const height = block.kind === 'big-number' ? 180 : 320;
    import('vega-embed')
      .then(async ({ default: embed }) => {
        if (cancelled) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the spec was checked when it was emitted
        const result = await embed(el, chartViewSpec(block, { palette, width: 'container', height }) as any, {
          actions: { export: true, source: false, compiled: false, editor: false },
          renderer: 'svg',
          // Specs never load anything: the data is inline.
          loader: { load: () => Promise.reject(new Error('Charts may not load data.')) } as never,
        });
        finalize = () => result.finalize();
        if (cancelled) finalize();
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      finalize?.();
    };
  }, [block, palette]);

  return (
    <figure className={styles.chart}>
      {failed ? <p className={styles.muted}>This chart could not be drawn.</p> : <div ref={ref} className={styles.chartCanvas} />}
      {block.truncated && <figcaption className={styles.truncated}>Drawn from the first {block.data.length} rows.</figcaption>}
    </figure>
  );
}

/** The chart palette for the current theme, read from the CSS tokens; updates when the theme changes. */
function useChartPalette(): ChartPalette {
  const [palette, setPalette] = useState<ChartPalette>(LIGHT_CHART_PALETTE);
  useEffect(() => {
    const read = () => setPalette(paletteFromTokens());
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', read);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', read);
    };
  }, []);
  return palette;
}

function paletteFromTokens(): ChartPalette {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim();
  const dark = css.colorScheme.includes('dark');
  const base = dark ? DARK_CHART_PALETTE : LIGHT_CHART_PALETTE;
  const accents = ['--color-yellow', '--color-pink', '--color-cyan', '--color-lime'].map(token).filter(Boolean);
  return {
    ...base,
    background: token('--color-surface') || base.background,
    ink: token('--color-ink') || base.ink,
    muted: token('--color-muted') || base.muted,
    accents: accents.length === 4 ? [...accents, ...base.accents.slice(4)] : base.accents,
    font: css.getPropertyValue('--font-sans').trim() || base.font,
  };
}
