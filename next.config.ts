import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  // Server-side chart PNGs (native resvg binding) and XLSX files, loaded from node_modules at runtime.
  serverExternalPackages: ['@resvg/resvg-js', 'exceljs', 'vega', 'vega-lite'],
};

export default config;
