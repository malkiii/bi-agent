import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  // Loaded from node_modules at runtime instead of being bundled:
  // - database clients (tedious pulls in @azure/identity, whose dependencies reference OS paths
  //   the bundler cannot resolve);
  // - server-side chart PNGs (native resvg binding) and XLSX files.
  serverExternalPackages: ['mssql', 'tedious', 'mysql2', '@resvg/resvg-js', 'exceljs', 'vega', 'vega-lite'],
};

export default config;
