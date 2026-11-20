/**
 * Lazily started database servers for driver test files. Unlike test/global-setup.ts (Mongo,
 * Postgres: used by many files), these servers are only needed by one test file each, so they
 * start on first use inside that file's process and only when that file runs:
 *
 *   startTestServers('mysql', 'mariadb');       // top of the test file: start both up front
 *   const uri = await testServerUri('mysql');   // MYSQL_TEST_URL, or a mysql:8.4 container
 *
 * URIs look like `mysql://root:pw@host:port` or `mssql://sa:pw@host:port`. Containers stop when
 * the file finishes (Testcontainers' reaper also removes them if the process dies).
 */
import { afterAll, beforeAll } from 'vitest';
import type { StartedTestContainer } from 'testcontainers';

export type TestServer = 'mysql' | 'mariadb' | 'mssql';

const ENV: Record<TestServer, string> = {
  mysql: 'MYSQL_TEST_URL',
  mariadb: 'MARIADB_TEST_URL',
  mssql: 'MSSQL_TEST_URL',
};

const started = new Map<TestServer, Promise<{ uri: string; container?: StartedTestContainer }>>();

afterAll(async () => {
  const servers = await Promise.allSettled(started.values());
  await Promise.all(servers.map((s) => (s.status === 'fulfilled' ? s.value.container?.stop() : undefined)));
});

/** SQL Server can take minutes to start on a busy machine, beyond vitest's 180 s hookTimeout. */
export const STARTUP_TIMEOUT_MS = 600_000;

/**
 * Starts the servers before any suite in the file (in parallel), with a generous timeout.
 * Call at the top level of a test file.
 */
export function startTestServers(...servers: TestServer[]) {
  beforeAll(() => Promise.all(servers.map(testServerUri)), STARTUP_TIMEOUT_MS);
}

export async function testServerUri(server: TestServer): Promise<string> {
  let entry = started.get(server);
  if (!entry) {
    entry = start(server);
    started.set(server, entry);
  }
  return (await entry).uri;
}

async function start(server: TestServer): Promise<{ uri: string; container?: StartedTestContainer }> {
  const external = process.env[ENV[server]];
  if (external) return { uri: external };
  const startupTimeout = STARTUP_TIMEOUT_MS - 10_000;

  if (server === 'mysql') {
    const { MySqlContainer } = await import('@testcontainers/mysql');
    const c = await new MySqlContainer('mysql:8.4').withStartupTimeout(startupTimeout).start();
    return { uri: `mysql://root:${encodeURIComponent(c.getRootPassword())}@${c.getHost()}:${c.getPort()}`, container: c };
  }
  if (server === 'mariadb') {
    const { MariaDbContainer } = await import('@testcontainers/mariadb');
    const c = await new MariaDbContainer('mariadb:11.8').withStartupTimeout(startupTimeout).start();
    return { uri: `mysql://root:${encodeURIComponent(c.getRootPassword())}@${c.getHost()}:${c.getPort()}`, container: c };
  }
  const { MSSQLServerContainer } = await import('@testcontainers/mssqlserver');
  const c = await new MSSQLServerContainer('mcr.microsoft.com/mssql/server:2022-latest')
    .acceptLicense()
    .withStartupTimeout(startupTimeout)
    .start();
  return {
    uri: `mssql://${c.getUsername()}:${encodeURIComponent(c.getPassword())}@${c.getHost()}:${c.getPort()}`,
    container: c,
  };
}
