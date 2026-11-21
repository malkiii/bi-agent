import { describe, expect, test } from 'vitest';
import type { ChartBlock } from '../conversations/answer';
import { LIGHT_CHART_PALETTE } from './chart';
import { renderChartPng } from './png';

const DATA = [
  { month: '2026-01', region: 'north', total: 12.5 },
  { month: '2026-02', region: 'north', total: 17.75 },
  { month: '2026-01', region: 'south', total: 20 },
  { month: '2026-02', region: 'south', total: 9 },
];

const xy = { x: { field: 'month', type: 'ordinal' }, y: { field: 'total', type: 'quantitative' }, color: { field: 'region', type: 'nominal' } };

const CHARTS: [ChartBlock['kind'], ChartBlock['spec']][] = [
  ['bar', { mark: 'bar', encoding: xy }],
  ['line', { mark: 'line', encoding: xy }],
  ['area', { mark: 'area', encoding: xy }],
  ['pie', { mark: { type: 'arc', innerRadius: 50 }, encoding: { theta: { field: 'total', type: 'quantitative' }, color: { field: 'region', type: 'nominal' } } }],
  ['scatter', { mark: 'point', encoding: { x: { field: 'total', type: 'quantitative' }, y: { field: 'total', type: 'quantitative' } } }],
  ['big-number', { mark: 'text', encoding: { text: { aggregate: 'sum', field: 'total', type: 'quantitative' } } }],
];

const block = (kind: ChartBlock['kind'], spec: ChartBlock['spec'], data = DATA): ChartBlock => ({
  type: 'chart',
  kind,
  title: `Sales (${kind}) — ünïcödé`,
  resultId: 'sales',
  spec,
  data,
  truncated: false,
});

/** Width and height from the PNG header. */
function pngSize(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** RGB of the top-left pixel (decoded by re-reading the PNG with resvg's image support). */
async function cornerPixel(png: Uint8Array): Promise<number[]> {
  const { Resvg } = await import('@resvg/resvg-js');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><image href="data:image/png;base64,${Buffer.from(png).toString('base64')}" width="1600" height="900"/></svg>`;
  const { pixels } = new Resvg(svg).render();
  return [...pixels.subarray(0, 3)];
}

const hex = (color: string) => [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));

describe('renderChartPng', () => {
  test.each(CHARTS)('renders a %s chart to a PNG', async (kind, spec) => {
    const png = await renderChartPng(block(kind, spec));

    expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    const { width, height } = pngSize(png);
    expect(width).toBeGreaterThanOrEqual(800);
    expect(height).toBeGreaterThan(300);
  });

  test('applies the palette: the background is the palette background', async () => {
    const spec = { mark: 'bar', encoding: xy };
    const custom = { ...LIGHT_CHART_PALETTE, background: '#1f1f1f' };
    const [light, other] = await Promise.all([
      renderChartPng(block('bar', spec)),
      renderChartPng(block('bar', spec), { palette: custom }),
    ]);

    expect(await cornerPixel(light)).toEqual(hex(LIGHT_CHART_PALETTE.background));
    expect(await cornerPixel(other)).toEqual(hex(custom.background));
  });

  test('renders a chart with no rows', async () => {
    const png = await renderChartPng(block('bar', { mark: 'bar', encoding: xy }, []));

    expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  });

  test('never fetches anything, even if a stored spec asks for a URL', async () => {
    const spec = { mark: 'bar', encoding: xy, transform: [{ lookup: 'region', from: { data: { url: 'http://127.0.0.1:1/x.json' }, key: 'region' } }] };

    await expect(renderChartPng(block('bar', spec))).rejects.toThrow(/not allowed|load/i);
  });
});
