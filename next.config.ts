import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  // Native DuckDB bindings (Uploads) and exceljs load from node_modules at runtime, not the bundle.
  serverExternalPackages: ['@duckdb/node-api', '@duckdb/node-bindings', 'exceljs'],
  // The platform binding is loaded dynamically, so file tracing needs a hint to copy it.
  outputFileTracingIncludes: { '/**': ['./node_modules/@duckdb/node-bindings-*/**/*'] },
  experimental: {
    // Uploads are up to 50 MB (plus multipart overhead); the proxy buffers request bodies up to this size.
    proxyClientMaxBodySize: '52mb',
  },
};

export default config;
