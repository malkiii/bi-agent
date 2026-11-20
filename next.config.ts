import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  // Database clients load at runtime from node_modules instead of being bundled (tedious pulls in
  // @azure/identity, whose dependencies reference OS paths the bundler cannot resolve).
  serverExternalPackages: ['mssql', 'tedious', 'mysql2'],
};

export default config;
