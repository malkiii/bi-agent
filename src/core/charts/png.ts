/**
 * Server-side chart rendering for Slack and Report Runs: Chart block → themed Vega-Lite →
 * Vega SVG (headless, no canvas) → PNG via resvg with the bundled Space Grotesk font.
 * No network access: specs are re-checked and Vega's loader refuses every load.
 *
 * The heavy libraries are imported on first use, so importing the App Core stays cheap.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { ChartBlock } from '../conversations/answer';
import type { ResultColumn } from '../data-sources/driver';
import { checkChartSpec, chartViewSpec, LIGHT_CHART_PALETTE, type ChartPalette } from './chart';

export interface ChartPngOptions {
  palette?: ChartPalette;
  /** CSS pixels; the PNG is rendered at 2x. */
  width?: number;
  height?: number;
}

const FONT_PACKAGE = '@expo-google-fonts/space-grotesk';
const FONT_FILES = ['400Regular/SpaceGrotesk_400Regular.ttf', '700Bold/SpaceGrotesk_700Bold.ttf'];

let fontPaths: string[] | undefined;
/** Font files on disk, found from the package root (bundlers must not try to import the .ttf files). */
function fonts(): string[] {
  if (!fontPaths) {
    const root = dirname(createRequire(import.meta.url).resolve(`${FONT_PACKAGE}/package.json`));
    fontPaths = FONT_FILES.map((f) => join(root, f));
  }
  return fontPaths;
}

export async function renderChartPng(block: ChartBlock, options: ChartPngOptions = {}): Promise<Uint8Array> {
  // Re-check what the spec may contain (marks, no URLs or data); fields were checked when it was emitted.
  const check = checkChartSpec(block.spec, fieldsOf(block.spec));
  if (!check.ok) throw new Error(`Chart spec not allowed: ${check.error}`);

  const [vega, { compile }, { Resvg }] = await Promise.all([import('vega'), import('vega-lite'), import('@resvg/resvg-js')]);
  const width = options.width ?? 800;
  const height = options.height ?? (block.kind === 'big-number' ? 300 : 450);
  const spec = chartViewSpec(block, { palette: options.palette ?? LIGHT_CHART_PALETTE, width, height });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- built from a checked spec
  const compiled = compile(spec as any).spec;

  const loader = vega.loader();
  loader.load = async (uri: string) => {
    throw new Error(`Charts may not load data (${uri}).`);
  };
  const view = new vega.View(vega.parse(compiled), { renderer: 'none', loader, logLevel: vega.Error });
  try {
    const svg = await view.toSVG();
    const png = new Resvg(svg, {
      font: { fontFiles: fonts(), loadSystemFonts: false, defaultFontFamily: 'Space Grotesk' },
      fitTo: { mode: 'zoom', value: 2 },
    })
      .render()
      .asPng();
    return new Uint8Array(png);
  } finally {
    view.finalize();
  }
}

function fieldsOf(spec: ChartBlock['spec']): ResultColumn[] {
  const names = new Set<string>();
  JSON.stringify(spec, (key, value: unknown) => {
    if (key === 'field' && typeof value === 'string') names.add(value);
    return value;
  });
  return [...names].map((name) => ({ name, type: 'other' }));
}
