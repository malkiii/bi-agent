/**
 * Turns a database connection URL into the Data Source kind it points at and the values of
 * that kind's form fields (see each DriverKind's `fields`), so an admin can paste one URL
 * instead of filling host, port, database and login by hand. Browser-safe: no Node imports.
 */

type SslMode = 'disable' | 'require' | 'verify-full';

export type ParsedConnectionUrl =
  | { ok: true; kind: string; values: Record<string, string> }
  | { ok: false; error: string };

/** The Data Source kinds a connection URL can point at. */
export const CONNECTION_URL_KINDS = ['postgres', 'mysql', 'mssql', 'mongodb'] as const;

const SUPPORTED = 'postgres://, mysql:// (or mariadb://), sqlserver:// and mongodb:// (or mongodb+srv://)';

const KINDS: Record<string, { kind: string; port: string }> = {
  postgres: { kind: 'postgres', port: '5432' },
  postgresql: { kind: 'postgres', port: '5432' },
  mysql: { kind: 'mysql', port: '3306' },
  mariadb: { kind: 'mysql', port: '3306' },
  sqlserver: { kind: 'mssql', port: '1433' },
  mssql: { kind: 'mssql', port: '1433' },
};

const fail = (error: string): ParsedConnectionUrl => ({ ok: false, error });

export function parseConnectionUrl(input: string): ParsedConnectionUrl {
  const text = input.trim().replace(/^jdbc:/i, '');
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)?.[1]?.toLowerCase();
  if (!scheme) return fail(`This is not a connection URL. Paste one starting with ${SUPPORTED}.`);

  if (scheme === 'mongodb' || scheme === 'mongodb+srv') return mongo(text);
  const target = KINDS[scheme];
  if (!target) return fail(`"${scheme}://" URLs are not supported. Paste one starting with ${SUPPORTED}.`);
  // JDBC-style SQL Server URLs: sqlserver://host:port;databaseName=x;user=u;password=p
  if (target.kind === 'mssql' && text.includes(';')) return jdbcSqlServer(text, target.port);

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail('This connection URL could not be read. Check it for typos.');
  }
  if (!url.hostname) return fail('The connection URL has no host.');

  const params = lowerCaseParams(url.searchParams);
  const values: Record<string, string> = {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port || target.port,
  };
  const database = decode(url.pathname.replace(/^\//, '')) || params.get('database') || params.get('databasename');
  if (database) values.database = database;
  const user = decode(url.username) || params.get('user') || params.get('username');
  if (user) values.user = user;
  const password = decode(url.password) || params.get('password');
  if (password) values.password = password;
  const sslMode = target.kind === 'postgres' ? postgresSsl(params) : target.kind === 'mysql' ? mysqlSsl(params) : sqlServerSsl(params);
  if (sslMode) values.sslMode = sslMode;
  return { ok: true, kind: target.kind, values };
}

function mongo(text: string): ParsedConnectionUrl {
  // Hosts may be a comma-separated list, which URL can't parse; only the path matters here.
  const authority = /^[^:]+:\/\/([^/?]*)/.exec(text)?.[1] ?? '';
  if (!authority.replace(/^.*@/, '')) return fail('The connection URL has no host.');
  const afterHosts = text.slice(text.indexOf('://') + 3 + authority.length);
  const database = decode(/^\/([^?]*)/.exec(afterHosts)?.[1] ?? '');
  return { ok: true, kind: 'mongodb', values: { connectionString: text, ...(database && { database }) } };
}

function jdbcSqlServer(text: string, defaultPort: string): ParsedConnectionUrl {
  const [address = '', ...pairs] = text.replace(/^[^:]+:\/\//, '').split(';');
  const [hostPart = '', port] = address.split(':');
  const host = hostPart.split('\\')[0];
  if (!host) return fail('The connection URL has no host.');
  const params = new Map<string, string>();
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at > 0) params.set(pair.slice(0, at).trim().toLowerCase(), pair.slice(at + 1).trim());
  }
  const values: Record<string, string> = { host, port: port || defaultPort };
  const database = params.get('databasename') ?? params.get('database');
  if (database) values.database = database;
  const user = params.get('user') ?? params.get('username');
  if (user) values.user = user;
  const password = params.get('password');
  if (password) values.password = password;
  const sslMode = sqlServerSsl(params);
  if (sslMode) values.sslMode = sslMode;
  return { ok: true, kind: 'mssql', values };
}

function postgresSsl(params: Map<string, string>): SslMode | undefined {
  const mode = params.get('sslmode')?.toLowerCase();
  if (!mode) return params.get('ssl') === 'true' ? 'require' : undefined;
  if (mode === 'disable') return 'disable';
  if (mode === 'verify-ca' || mode === 'verify-full') return 'verify-full';
  return 'require';
}

function mysqlSsl(params: Map<string, string>): SslMode | undefined {
  const mode = (params.get('ssl-mode') ?? params.get('sslmode'))?.toLowerCase().replaceAll('_', '-');
  if (mode === 'disabled' || mode === 'disable') return 'disable';
  if (mode === 'verify-ca' || mode === 'verify-identity' || mode === 'verify-full') return 'verify-full';
  if (mode) return 'require';
  const ssl = params.get('ssl')?.toLowerCase();
  if (ssl === 'true' || ssl === '1') return 'require';
  if (ssl === 'false' || ssl === '0') return 'disable';
  return undefined;
}

function sqlServerSsl(params: Map<string, string>): SslMode | undefined {
  const encrypt = params.get('encrypt')?.toLowerCase();
  if (encrypt === undefined) return undefined;
  if (encrypt === 'false' || encrypt === 'no' || encrypt === 'optional') return 'disable';
  return params.get('trustservercertificate')?.toLowerCase() === 'true' ? 'require' : 'verify-full';
}

/** Query parameters with lower-case names (JDBC and driver docs disagree on case). */
function lowerCaseParams(search: URLSearchParams): Map<string, string> {
  return new Map([...search].map(([k, v]) => [k.toLowerCase(), v]));
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
