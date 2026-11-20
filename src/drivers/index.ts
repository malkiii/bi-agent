/**
 * Every Data Source kind Botley ships with. Add a new kind here after its driver passes
 * the contract suite (src/drivers/contract). Server-only: drivers import native DB clients.
 */
import type { DriverRegistry } from '@/core/data-sources/driver';
import { mongoKind } from './mongodb/mongodb';
import { postgresKind } from './postgres/postgres';

export const builtInDrivers: DriverRegistry = {
  [postgresKind.kind]: postgresKind,
  [mongoKind.kind]: mongoKind,
};
