/**
 * Every Data Source kind Botley ships with. Add a new kind here after its driver passes
 * the contract suite (src/drivers/contract). Server-only: drivers import native DB clients.
 */
import type { DriverRegistry } from '@/core/data-sources/driver';
import { postgresKind } from './postgres/postgres';
import { mysqlKind } from './mysql/mysql';
import { mssqlKind } from './mssql/mssql';

export const builtInDrivers: DriverRegistry = {
  [postgresKind.kind]: postgresKind,
  [mysqlKind.kind]: mysqlKind,
  [mssqlKind.kind]: mssqlKind,
};
