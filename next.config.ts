import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  // Loaded from node_modules at runtime instead of being bundled:
  // - database clients (tedious pulls in @azure/identity, whose dependencies reference OS paths
  //   the bundler cannot resolve);
  // - server-side chart PNGs (native resvg binding) and XLSX files;
  // - DuckDB for uploaded Datasets (native binding per platform).
  serverExternalPackages: [
    'mssql',
    'tedious',
    'mysql2',
    '@resvg/resvg-js',
    'exceljs',
    'vega',
    'vega-lite',
    '@duckdb/node-api',
    '@duckdb/node-bindings',
  ],
  experimental: {
    // The proxy buffers request bodies up to this size; uploads may be 50 MB plus the multipart envelope.
    proxyClientMaxBodySize: '51mb',
  },
};

export default config;
