import { describe, expect, test } from 'vitest';
import { parseConnectionUrl } from './connection-url';

describe('detecting a Data Source from its connection URL', () => {
  test('a Postgres URL fills host, port, database, login and SSL', () => {
    expect(parseConnectionUrl('postgres://reader:s%40cret@db.example.com:6543/sales?sslmode=verify-full')).toEqual({
      ok: true,
      kind: 'postgres',
      values: {
        host: 'db.example.com',
        port: '6543',
        database: 'sales',
        user: 'reader',
        password: 's@cret',
        sslMode: 'verify-full',
      },
    });
  });

  test('missing parts take the usual defaults or stay blank', () => {
    expect(parseConnectionUrl('  postgresql://db/sales  ')).toEqual({
      ok: true,
      kind: 'postgres',
      values: { host: 'db', port: '5432', database: 'sales' },
    });
  });

  test.each([
    ['disable', 'disable'],
    ['prefer', 'require'],
    ['require', 'require'],
    ['verify-ca', 'verify-full'],
  ])('Postgres sslmode=%s becomes %s', (sslmode, sslMode) => {
    expect(parseConnectionUrl(`postgres://db/sales?sslmode=${sslmode}`)).toMatchObject({ values: { sslMode } });
  });

  test('MySQL and MariaDB URLs both make a MySQL / MariaDB Data Source', () => {
    expect(parseConnectionUrl('mysql://root:pw@localhost/shop?ssl-mode=DISABLED')).toEqual({
      ok: true,
      kind: 'mysql',
      values: { host: 'localhost', port: '3306', database: 'shop', user: 'root', password: 'pw', sslMode: 'disable' },
    });
    expect(parseConnectionUrl('mariadb://maria:3307/shop?ssl=true')).toMatchObject({
      kind: 'mysql',
      values: { host: 'maria', port: '3307', sslMode: 'require' },
    });
  });

  test('a SQL Server URL, also in JDBC style, makes a SQL Server Data Source', () => {
    expect(parseConnectionUrl('sqlserver://sa:pw@sql.local:1444/finance?encrypt=true&trustServerCertificate=true')).toEqual({
      ok: true,
      kind: 'mssql',
      values: { host: 'sql.local', port: '1444', database: 'finance', user: 'sa', password: 'pw', sslMode: 'require' },
    });
    expect(
      parseConnectionUrl('jdbc:sqlserver://sql.local;databaseName=finance;user=sa;password=p;encrypt=false'),
    ).toEqual({
      ok: true,
      kind: 'mssql',
      values: { host: 'sql.local', port: '1433', database: 'finance', user: 'sa', password: 'p', sslMode: 'disable' },
    });
  });

  test('a MongoDB URI is kept whole as the connection string, with its database', () => {
    const uri = 'mongodb+srv://reader:pw@cluster0.example.net/analytics?retryWrites=true';

    expect(parseConnectionUrl(uri)).toEqual({ ok: true, kind: 'mongodb', values: { connectionString: uri, database: 'analytics' } });
  });

  test('an unknown scheme or a URL without a host is refused with a reason', () => {
    expect(parseConnectionUrl('redis://cache:6379')).toEqual({
      ok: false,
      error: expect.stringMatching(/postgres.*mysql.*sqlserver.*mongodb/),
    });
    expect(parseConnectionUrl('not a url')).toMatchObject({ ok: false });
    expect(parseConnectionUrl('postgres:///sales')).toEqual({ ok: false, error: expect.stringMatching(/host/i) });
    expect(parseConnectionUrl('mongodb://')).toEqual({ ok: false, error: expect.stringMatching(/host/i) });
  });
});
