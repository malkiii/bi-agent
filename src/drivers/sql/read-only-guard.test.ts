import { describe, expect, test } from 'vitest';
import { QueryRejectedError } from '@/core/data-sources/driver';
import { assertReadOnlySql, type SqlFlavour } from './read-only-guard';

function refuses(flavour: SqlFlavour, cases: Record<string, string>) {
  test.each(Object.entries(cases))('refuses %s', (_name, sql) => {
    expect(() => assertReadOnlySql(sql, flavour)).toThrow(QueryRejectedError);
  });
}

function accepts(flavour: SqlFlavour, cases: Record<string, string>) {
  test.each(Object.entries(cases))('accepts %s', (_name, sql) => {
    expect(() => assertReadOnlySql(sql, flavour)).not.toThrow();
  });
}

describe('T-SQL (statements need no semicolon between them)', () => {
  refuses('tsql', {
    'a DELETE after a SELECT without a semicolon': 'SELECT 1 DELETE FROM orders',
    'an UPDATE after a SELECT on a new line': 'SELECT * FROM orders\nUPDATE orders SET amount = 0',
    EXEC: "SELECT 1 EXEC sp_configure 'xp_cmdshell', 1",
    'EXEC on its own': 'EXEC xp_cmdshell "dir"',
    'SELECT INTO': 'SELECT * INTO evil FROM orders',
    'SELECT INTO a temp table': 'SELECT * INTO #t FROM orders',
    OPENROWSET: "SELECT * FROM OPENROWSET(BULK 'C:\\secrets.txt', SINGLE_CLOB) AS x",
    OPENQUERY: "SELECT * FROM OPENQUERY(linked, 'DELETE FROM t')",
    OPENDATASOURCE: "SELECT * FROM OPENDATASOURCE('SQLNCLI', 'Data Source=x').db.dbo.t",
    WAITFOR: "SELECT 1 WAITFOR DELAY '00:00:10'",
    'COMMIT after a SELECT': 'SELECT 1 COMMIT',
    'BEGIN TRAN after a SELECT': 'SELECT 1 BEGIN TRAN',
    'USE another database': 'SELECT 1 USE master',
    RECEIVE: 'SELECT 1 RECEIVE * FROM queue',
    'SET options': 'SELECT 1 SET NOCOUNT ON',
    'locking hint keywords after a SELECT': 'SELECT 1 DBCC FREEPROCCACHE',
    'a SHUTDOWN after a SELECT': 'SELECT 1 SHUTDOWN WITH NOWAIT',
    'a DELETE hidden after a bracketed name': 'SELECT [a]]b] FROM t DELETE FROM t',
  });
  accepts('tsql', {
    'TOP and bracketed names': 'SELECT TOP 10 [order id], [delete] FROM dbo.[Big Deals]',
    'keywords inside strings and comments': "SELECT 'drop; delete' AS x -- exec\n/* waitfor */",
    'a CTE with OPTION': 'WITH n AS (SELECT 1 AS i) SELECT i FROM n OPTION (MAXRECURSION 0)',
    'FOR JSON': 'SELECT id FROM orders FOR JSON PATH',
  });
});

describe('MySQL / MariaDB', () => {
  refuses('mysql', {
    'multiple statements': 'SELECT 1; DELETE FROM orders',
    'multiple statements hidden in a # comment': 'SELECT 1 # comment\n; DELETE FROM orders',
    'SELECT INTO OUTFILE': "SELECT * FROM orders INTO OUTFILE '/tmp/orders.csv'",
    'SELECT INTO DUMPFILE': "SELECT * FROM orders INTO DUMPFILE '/tmp/x'",
    'SELECT INTO a variable': 'SELECT id INTO @x FROM orders LIMIT 1',
    LOAD_FILE: "SELECT LOAD_FILE('/etc/passwd')",
    'FOR UPDATE': 'SELECT * FROM orders FOR UPDATE',
    'FOR SHARE': 'SELECT * FROM orders FOR SHARE',
    'LOCK IN SHARE MODE': 'SELECT * FROM orders LOCK IN SHARE MODE',
    GET_LOCK: "SELECT GET_LOCK('botley', 10)",
    'a DELETE hidden after a backslash-escaped quote': "SELECT 'it\\'s' AS x; DELETE FROM orders",
    'a DELETE hidden after a backtick name': 'SELECT `a``b`; DELETE FROM orders',
    'an executable comment (MySQL runs it)': "SELECT * FROM orders /*! INTO OUTFILE '/tmp/x' */",
    'a versioned executable comment': 'SELECT * FROM orders /*!80000 FOR UPDATE */',
    'INTO OUTFILE after "--" with no space (minus minus, not a comment)':
      "SELECT 1 --1 INTO OUTFILE '/tmp/x'",
    'a MariaDB executable comment':'SELECT * FROM orders /*M! FOR UPDATE */',
  });
  accepts('mysql', {
    'backtick-quoted keyword names': 'SELECT `delete`, `update` FROM `orders`',
    'a backslash-escaped quote in a string': "SELECT 'it\\'s; delete' AS x",
    'SLEEP (bounded by the timeout)': 'SELECT SLEEP(1)',
    'a market share column': 'SELECT share FROM stats',
    'an ordinary comment': 'SELECT 1 /* for update */',
  });
});

describe('every flavour', () => {
  for (const flavour of ['postgresql', 'mysql', 'tsql', 'duckdb'] as const) {
    test(`${flavour}: FOR SHARE locking is refused`, () => {
      expect(() => assertReadOnlySql('SELECT * FROM orders FOR SHARE', flavour)).toThrow(QueryRejectedError);
    });
  }
});
