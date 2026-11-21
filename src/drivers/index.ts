/**
 * Every Data Source kind BIBot ships with. Add a new kind here after its driver passes
 * the contract suite (src/drivers/contract). Server-only: drivers import native DB clients.
 */
import type { DriverRegistry } from '@/core/data-sources/driver';
import { mongoKind } from './mongodb/mongodb';
import { postgresKind } from './postgres/postgres';
import { mysqlKind } from './mysql/mysql';
import { mssqlKind } from './mssql/mssql';
import { salesforceKind } from './salesforce/salesforce';

export const builtInDrivers: DriverRegistry = {
  [postgresKind.kind]: postgresKind,
  [mysqlKind.kind]: mysqlKind,
  [mssqlKind.kind]: mssqlKind,
  [mongoKind.kind]: mongoKind,
  [salesforceKind.kind]: salesforceKind,
};
