// Bundles the worker entry (and the shared src/ code it imports) into dist/worker.mjs.
// npm packages stay external and are resolved from node_modules at runtime.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/worker/main.ts'],
  outfile: 'dist/worker.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});
