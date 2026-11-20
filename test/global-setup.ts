import type { TestProject } from 'vitest/node';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { MySqlContainer } from '@testcontainers/mysql';
import { MariaDbContainer } from '@testcontainers/mariadb';
import { MSSQLServerContainer } from '@testcontainers/mssqlserver';

/**
 * Starts the real databases once per test run (all in parallel) and provides their URIs to
 * every test file:
 * - `mongoUri`: MONGO_TEST_URL, or a throwaway mongo:8 container.
 * - `postgresUri`: POSTGRES_TEST_URL (a superuser URI), or a throwaway postgres:17 container.
 * - `mysqlUri` / `mariadbUri`: MYSQL_TEST_URL / MARIADB_TEST_URL (`mysql://root:pw@host:port`),
 *   or mysql:8.4 / mariadb:11.8 containers.
 * - `mssqlUri`: MSSQL_TEST_URL (`mssql://sa:pw@host:port`), or a SQL Server 2022 container.
 * Test files isolate themselves by database name, not by container.
 */
export default async function setup(project: TestProject) {
  const started = await Promise.all([startMongo(), startPostgres(), startMysql(), startMariadb(), startMssql()]);
  const [mongoUri, postgresUri, mysqlUri, mariadbUri, mssqlUri] = started;
  project.provide('mongoUri', mongoUri.uri);
  project.provide('postgresUri', postgresUri.uri);
  project.provide('mysqlUri', mysqlUri.uri);
  project.provide('mariadbUri', mariadbUri.uri);
  project.provide('mssqlUri', mssqlUri.uri);
  return async () => {
    await Promise.all(started.map((s) => s.stop()));
  };
}

interface Started {
  uri: string;
  stop(): Promise<unknown>;
}

const noop = async () => {};

async function startMongo(): Promise<Started> {
  const external = process.env.MONGO_TEST_URL;
  if (external) return { uri: external, stop: noop };
  const mongo = await new MongoDBContainer('mongo:8').start();
  const uri = new URL(mongo.getConnectionString());
  uri.searchParams.set('directConnection', 'true');
  return { uri: uri.toString(), stop: () => mongo.stop() };
}

async function startPostgres(): Promise<Started> {
  const external = process.env.POSTGRES_TEST_URL;
  if (external) return { uri: external, stop: noop };
  const postgres = await new PostgreSqlContainer('postgres:17-alpine').start();
  return { uri: postgres.getConnectionUri(), stop: () => postgres.stop() };
}

async function startMysql(): Promise<Started> {
  const external = process.env.MYSQL_TEST_URL;
  if (external) return { uri: external, stop: noop };
  const mysql = await new MySqlContainer('mysql:8.4').start();
  const uri = `mysql://root:${encodeURIComponent(mysql.getRootPassword())}@${mysql.getHost()}:${mysql.getPort()}`;
  return { uri, stop: () => mysql.stop() };
}

async function startMariadb(): Promise<Started> {
  const external = process.env.MARIADB_TEST_URL;
  if (external) return { uri: external, stop: noop };
  const mariadb = await new MariaDbContainer('mariadb:11.8').start();
  const uri = `mysql://root:${encodeURIComponent(mariadb.getRootPassword())}@${mariadb.getHost()}:${mariadb.getPort()}`;
  return { uri, stop: () => mariadb.stop() };
}

async function startMssql(): Promise<Started> {
  const external = process.env.MSSQL_TEST_URL;
  if (external) return { uri: external, stop: noop };
  const mssql = await new MSSQLServerContainer('mcr.microsoft.com/mssql/server:2022-latest').acceptLicense().start();
  const uri = `mssql://${mssql.getUsername()}:${encodeURIComponent(mssql.getPassword())}@${mssql.getHost()}:${mssql.getPort()}`;
  return { uri, stop: () => mssql.stop() };
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
    postgresUri: string;
    mysqlUri: string;
    mariadbUri: string;
    mssqlUri: string;
  }
}
