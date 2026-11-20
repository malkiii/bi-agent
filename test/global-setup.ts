import type { TestProject } from 'vitest/node';
import { MongoDBContainer } from '@testcontainers/mongodb';

/**
 * Provides `mongoUri` to every test file. Uses MONGO_TEST_URL when set
 * (e.g. a Mongo you already run), otherwise starts a throwaway mongo:8 container.
 * Test files isolate themselves by database name, not by container.
 */
export default async function setup(project: TestProject) {
  const external = process.env.MONGO_TEST_URL;
  if (external) {
    project.provide('mongoUri', external);
    return;
  }
  const mongo = await new MongoDBContainer('mongo:8').start();
  const uri = new URL(mongo.getConnectionString());
  uri.searchParams.set('directConnection', 'true');
  project.provide('mongoUri', uri.toString());
  return async () => {
    await mongo.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}
