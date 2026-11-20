import { bootstrap, type ServerRuntime } from '@/server/bootstrap';
import { parseServerConfig } from '@/server/config';

const globalForRuntime = globalThis as unknown as { botleyRuntime?: Promise<ServerRuntime> };

/**
 * The web process's App Core, created lazily on first use (never at import time,
 * so `next build` works without a database) and reused across requests and HMR reloads.
 */
export function getServerRuntime(): Promise<ServerRuntime> {
  globalForRuntime.botleyRuntime ??= bootstrap(parseServerConfig(process.env)).catch((error: unknown) => {
    globalForRuntime.botleyRuntime = undefined;
    throw error;
  });
  return globalForRuntime.botleyRuntime;
}

export async function getCore() {
  return (await getServerRuntime()).core;
}
