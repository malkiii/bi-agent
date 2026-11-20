/**
 * Test helpers for SQL Server: a fresh database per caller on a lazily started server
 * (../sql/test-server.ts), plus an `sa` connection to seed it.
 */
import { randomUUID } from 'node:crypto';
import sql from 'mssql';
import { testServerUri } from '../sql/test-server';
import type { MssqlConnection } from './mssql';

export interface MssqlTestDatabase {
  /** Connection settings for the new database, as `sa`. */
  connection: MssqlConnection;
  /** Runs a T-SQL batch as `sa` in the new database. */
  sql(text: string): Promise<sql.IResult<Record<string, unknown>>>;
  /** Creates a login that is only a db_datareader in the new database; dropped with it. */
  createReadOnlyUser(): Promise<MssqlConnection>;
  drop(): Promise<void>;
}

export const CONTRACT_FIXTURE_SQL = `
  CREATE TABLE orders (id int PRIMARY KEY, region nvarchar(20) NOT NULL, amount decimal(10, 2) NOT NULL);
  INSERT INTO orders VALUES (1, 'north', 10.5), (2, 'south', 20), (3, 'north', 7.25);
`;

function poolFor(c: Omit<MssqlConnection, 'sslMode'> & { database: string }) {
  return new sql.ConnectionPool({
    server: c.host,
    port: c.port,
    database: c.database,
    user: c.user,
    password: c.password,
    options: { encrypt: false, trustServerCertificate: true },
  });
}

export async function createMssqlTestDatabase(): Promise<MssqlTestDatabase> {
  const url = new URL(await testServerUri('mssql'));
  const database = `test_${randomUUID().replaceAll('-', '')}`;
  const connection: MssqlConnection = {
    host: url.hostname,
    port: Number(url.port || 1433),
    database,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    sslMode: 'disable',
  };

  const master = await poolFor({ ...connection, database: 'master' }).connect();
  await master.request().batch(`CREATE DATABASE ${database}`);
  const admin = await poolFor(connection).connect();
  const logins: string[] = [];

  return {
    connection,
    sql: (text) => admin.request().batch(text),
    async createReadOnlyUser() {
      const login = `ro_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      const password = `Pw-${randomUUID()}`;
      await master.request().batch(`CREATE LOGIN ${login} WITH PASSWORD = '${password}', CHECK_POLICY = OFF`);
      await admin.request().batch(`CREATE USER ${login} FOR LOGIN ${login}; ALTER ROLE db_datareader ADD MEMBER ${login};`);
      logins.push(login);
      return { ...connection, user: login, password };
    },
    async drop() {
      await admin.close();
      await master
        .request()
        .batch(`ALTER DATABASE ${database} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${database};`);
      for (const login of logins) await master.request().batch(`DROP LOGIN ${login}`);
      await master.close();
    },
  };
}
