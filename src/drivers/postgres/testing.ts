/**
 * Test helpers for Postgres: a fresh database per caller on the server started by
 * test/global-setup.ts, plus a superuser client to seed and inspect it.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import type { PostgresConnection } from './postgres';

export interface PostgresTestDatabase {
  /** Connection settings for the new database, as the superuser. */
  connection: PostgresConnection;
  /** Runs SQL as the superuser in the new database. */
  sql(text: string): Promise<pg.QueryResult>;
  /** Creates a login role that may only SELECT the tables in `public`; dropped with the database. */
  createReadOnlyUser(): Promise<PostgresConnection>;
  drop(): Promise<void>;
}

export const CONTRACT_FIXTURE_SQL = `
  CREATE TABLE orders (id integer PRIMARY KEY, region text NOT NULL, amount numeric(10, 2) NOT NULL);
  INSERT INTO orders VALUES (1, 'north', 10.5), (2, 'south', 20), (3, 'north', 7.25);
`;

export async function createPostgresTestDatabase(): Promise<PostgresTestDatabase> {
  const server = new URL(inject('postgresUri'));
  const database = `test_${randomUUID().replaceAll('-', '')}`;

  const admin = new pg.Client({ connectionString: server.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();

  const connection: PostgresConnection = {
    host: server.hostname,
    port: Number(server.port || 5432),
    database,
    user: decodeURIComponent(server.username),
    password: decodeURIComponent(server.password),
    sslMode: 'disable',
  };
  const client = new pg.Client({ ...connection, ssl: false });
  await client.connect();

  const roles: string[] = [];

  return {
    connection,
    sql: (text) => client.query(text),
    async createReadOnlyUser() {
      const user = `ro_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      const password = `pw-${randomUUID()}`;
      await client.query(`CREATE ROLE ${user} LOGIN PASSWORD '${password}'`);
      await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${user}`);
      roles.push(user);
      return { ...connection, user, password };
    },
    async drop() {
      for (const role of roles) await client.query(`DROP OWNED BY ${role}`);
      await client.end();
      const admin = new pg.Client({ connectionString: server.toString() });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      for (const role of roles) await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    },
  };
}
