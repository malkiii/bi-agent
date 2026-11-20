/**
 * Test helpers for MySQL and MariaDB: a fresh database per caller on a lazily started server
 * (../sql/test-server.ts), plus a root connection to seed it.
 */
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { testServerUri } from '../sql/test-server';
import type { MysqlConnection } from './mysql';

export interface MysqlTestDatabase {
  /** Connection settings for the new database, as root. */
  connection: MysqlConnection;
  /** Runs SQL (several statements allowed) as root in the new database. */
  sql<T = mysql.RowDataPacket[]>(text: string): Promise<T>;
  /** Creates a user that may only SELECT in the new database; dropped with it. */
  createReadOnlyUser(): Promise<MysqlConnection>;
  drop(): Promise<void>;
}

export const CONTRACT_FIXTURE_SQL = `
  CREATE TABLE orders (id int PRIMARY KEY, region varchar(20) NOT NULL, amount decimal(10, 2) NOT NULL);
  INSERT INTO orders VALUES (1, 'north', 10.5), (2, 'south', 20), (3, 'north', 7.25);
`;

export async function createMysqlTestDatabase(server: 'mysql' | 'mariadb' = 'mysql'): Promise<MysqlTestDatabase> {
  const url = new URL(await testServerUri(server));
  const database = `test_${randomUUID().replaceAll('-', '')}`;
  const connection: MysqlConnection = {
    host: url.hostname,
    port: Number(url.port || 3306),
    database,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    sslMode: 'disable',
  };

  const { host, port, user, password } = connection;
  const admin = await mysql.createConnection({ host, port, user, password, multipleStatements: true });
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.query(`USE ${database}`);

  const users: string[] = [];

  return {
    connection,
    sql: async <T>(text: string) => (await admin.query(text))[0] as T,
    async createReadOnlyUser() {
      const user = `ro_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      const password = `pw-${randomUUID()}`;
      await admin.query(`CREATE USER '${user}'@'%' IDENTIFIED BY '${password}'`);
      await admin.query(`GRANT SELECT ON ${database}.* TO '${user}'@'%'`);
      users.push(user);
      return { ...connection, user, password };
    },
    async drop() {
      for (const user of users) await admin.query(`DROP USER IF EXISTS '${user}'@'%'`);
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
    },
  };
}
