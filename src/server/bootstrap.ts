import { MongoClient, type Db } from 'mongodb';
import { createAppCore, prepareDatabase, type AppCore } from '@/core';
import { systemClock } from '@/adapters/system-clock';
import { builtInDrivers } from '@/drivers';
import { unconfiguredLlm, unconfiguredSlack } from '@/adapters/unconfigured';
import type { ServerConfig } from './config';

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export interface ServerRuntime {
  core: AppCore;
  db: Db;
  client: MongoClient;
}

/** Connects to Mongo, prepares indexes and builds the App Core with production adapters. */
export async function bootstrap(config: ServerConfig): Promise<ServerRuntime> {
  const client = new MongoClient(config.mongoUrl, { serverSelectionTimeoutMS: 30_000 });
  await client.connect();
  const db = client.db(config.mongoDb);
  await db.command({ ping: 1 });
  await prepareDatabase(db);
  const core = createAppCore({
    db,
    clock: systemClock,
    slack: unconfiguredSlack,
    llm: unconfiguredLlm,
    drivers: builtInDrivers,
    config: config.core,
  });
  return { core, db, client };
}
