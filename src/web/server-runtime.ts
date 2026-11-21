import { bootstrap, type ServerRuntime } from '@/server/bootstrap';
import { parseServerConfig } from '@/server/config';

const globalForRuntime = globalThis as unknown as { bibotRuntime?: Promise<ServerRuntime> };

/**
 * The web process's App Core, created lazily on first use (never at import time,
 * so `next build` works without a database) and reused across requests and HMR reloads.
 */
export function getServerRuntime(): Promise<ServerRuntime> {
  globalForRuntime.bibotRuntime ??= bootstrap(parseServerConfig(process.env)).catch((error: unknown) => {
    globalForRuntime.bibotRuntime = undefined;
    throw error;
  });
  return globalForRuntime.bibotRuntime;
}

export async function getCore() {
  return (await getServerRuntime()).core;
}
