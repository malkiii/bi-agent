import { MongoClient, type Db } from 'mongodb';
import { createAppCore, prepareDatabase, type AppCore } from '@/core';
import { systemClock } from '@/adapters/system-clock';
import { builtInDrivers } from '@/drivers';
import { createUploadsBackend } from '@/drivers/uploads';
import { unconfiguredLlm, unconfiguredSlack } from '@/adapters/unconfigured';
import { createLanguageModelProvider } from '@/adapters/llm';
import { createSlackWebGateway } from '@/adapters/slack-web-gateway';
import { WebClient } from '@slack/web-api';
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
  const uploads = createUploadsBackend(config.uploadsDir);
  const core = createAppCore({
    db,
    clock: systemClock,
    slack: config.slack ? createSlackWebGateway(new WebClient(config.slack.botToken)) : unconfiguredSlack,
    llm: config.llm ? createLanguageModelProvider(config.llm) : unconfiguredLlm,
    drivers: { ...builtInDrivers, [uploads.kind.kind]: uploads.kind },
    uploadStorage: uploads.storage,
    config: config.core,
    onAgentError: (error) => console.error('Answer failed:', error),
  });
  return { core, db, client };
}
