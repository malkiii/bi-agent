/**
 * Test helpers for MongoDB: a fresh database per caller on the server started by
 * test/global-setup.ts (the same server the App Core tests use), plus a client to seed
 * and inspect it.
 */
import { randomUUID } from 'node:crypto';
import { MongoClient, type Db } from 'mongodb';
import { inject } from 'vitest';
import type { MongoConnection } from './mongodb';

export interface MongoTestDatabase {
  connection: MongoConnection;
  /** The new database, for seeding and inspecting without going through the driver. */
  db: Db;
  drop(): Promise<void>;
}

/** The contract fixture: `orders` with id (int), region (string), amount (int or double). */
export const CONTRACT_FIXTURE_ORDERS = [
  { id: 1, region: 'north', amount: 10.5 },
  { id: 2, region: 'south', amount: 20 },
  { id: 3, region: 'north', amount: 7.25 },
];

export async function createMongoTestDatabase(): Promise<MongoTestDatabase> {
  const uri = inject('mongoUri');
  const database = `test_${randomUUID().replaceAll('-', '')}`;
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(database);

  return {
    connection: { uri, database },
    db,
    async drop() {
      await db.dropDatabase();
      await client.close();
    },
  };
}
