import type { TestProject } from 'vitest/node';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Starts the real databases once per test run and provides their URIs to every test file:
 * - `mongoUri`: MONGO_TEST_URL, or a throwaway mongo:8 container.
 * - `postgresUri`: POSTGRES_TEST_URL (a superuser URI), or a throwaway postgres:17 container.
 * Test files isolate themselves by database name, not by container.
 */
export default async function setup(project: TestProject) {
  const [mongoUri, postgresUri] = await Promise.all([startMongo(), startPostgres()]);
  project.provide('mongoUri', mongoUri.uri);
  project.provide('postgresUri', postgresUri.uri);
  return async () => {
    await Promise.all([mongoUri.stop(), postgresUri.stop()]);
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

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
    postgresUri: string;
  }
}
