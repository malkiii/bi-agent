/**
 * A fake Salesforce org over real HTTP, for tests (no real org needed). One origin serves
 * both the login host (OAuth authorize/token) and the instance (REST API).
 *
 * - SOQL is not parsed: `soql(query, records)` registers the exact query text and its records.
 * - OAuth: `approve(authorizeUrl)` plays the admin clicking "Allow" and returns the code that
 *   Salesforce would send to the callback. The token endpoint checks client credentials,
 *   redirect URI and the PKCE verifier.
 * - `expireAccessTokens()` makes the next API call answer 401; `revokeRefreshTokens()` makes
 *   refreshes fail with `invalid_grant`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeField {
  name: string;
  type: string;
  nillable?: boolean;
  length?: number;
  referenceTo?: string[];
}

export interface FakeObject {
  name: string;
  label?: string;
  queryable?: boolean;
  fields: FakeField[];
}

export interface FakeRequest {
  method: string;
  path: string;
  soql?: string;
}

interface FakeQuery {
  records: Record<string, unknown>[];
  delayMs: number;
  type: string;
}

export interface FakeSalesforce {
  /** Base URL: use it as both the login URL and the instance URL. */
  url: string;
  clientId: string;
  clientSecret: string;
  apiVersion: string;
  objects: FakeObject[];
  /** Every request received, in order. */
  requests: FakeRequest[];
  /** Records returned per page before `nextRecordsUrl`. */
  pageSize: number;
  soql(query: string, records: Record<string, unknown>[], options?: { delayMs?: number; type?: string }): void;
  /** Valid tokens, as if an admin had connected already. */
  issueTokens(): { accessToken: string; refreshToken: string };
  approve(authorizeUrl: string): string;
  expireAccessTokens(): void;
  revokeRefreshTokens(): void;
  close(): Promise<void>;
}

/** The contract fixture as a custom object named `orders`. */
export const CONTRACT_FIXTURE_OBJECT: FakeObject = {
  name: 'orders',
  label: 'Orders',
  fields: [
    { name: 'id', type: 'int', nillable: false },
    { name: 'region', type: 'string', nillable: false, length: 80 },
    { name: 'amount', type: 'double', nillable: false },
  ],
};

export const CONTRACT_FIXTURE_RECORDS = [
  { id: 1, region: 'north', amount: 10.5 },
  { id: 2, region: 'south', amount: 20 },
  { id: 3, region: 'north', amount: 7.25 },
];

const token = () => randomBytes(12).toString('hex');

export async function startFakeSalesforce(): Promise<FakeSalesforce> {
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const queries = new Map<string, FakeQuery>();
  const cursors = new Map<string, { records: Record<string, unknown>[]; type: string; offset: number }>();

  const fake: FakeSalesforce = {
    url: '',
    clientId: 'fake-client-id',
    clientSecret: 'fake-client-secret',
    apiVersion: 'v68.0',
    objects: [],
    requests: [],
    pageSize: 2000,
    soql(query, records, options = {}) {
      queries.set(query, { records, delayMs: options.delayMs ?? 0, type: options.type ?? 'Record' });
    },
    issueTokens() {
      const accessToken = token();
      const refreshToken = token();
      accessTokens.add(accessToken);
      refreshTokens.add(refreshToken);
      return { accessToken, refreshToken };
    },
    approve(authorizeUrl) {
      const params = new URL(authorizeUrl).searchParams;
      if (params.get('client_id') !== fake.clientId) throw new Error('fake Salesforce: unknown client_id');
      if (params.get('code_challenge_method') !== 'S256') throw new Error('fake Salesforce: PKCE S256 required');
      const code = token();
      codes.set(code, { challenge: params.get('code_challenge') ?? '', redirectUri: params.get('redirect_uri') ?? '' });
      return code;
    },
    expireAccessTokens() {
      accessTokens.clear();
    },
    revokeRefreshTokens() {
      refreshTokens.clear();
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };

  function send(res: ServerResponse, status: number, body: unknown) {
    if (res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  }

  function tokenResponse(refreshToken?: string) {
    const accessToken = token();
    accessTokens.add(accessToken);
    return {
      access_token: accessToken,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      instance_url: fake.url,
      id: `${fake.url}/id/00D000000000001/005000000000001`,
      token_type: 'Bearer',
      issued_at: String(Date.now()),
      scope: 'api refresh_token',
    };
  }

  async function oauthToken(req: IncomingMessage, res: ServerResponse) {
    const form = await readForm(req);
    if (form.get('client_id') !== fake.clientId || form.get('client_secret') !== fake.clientSecret) {
      return send(res, 400, { error: 'invalid_client', error_description: 'invalid client credentials' });
    }
    if (form.get('grant_type') === 'authorization_code') {
      const pending = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (!pending || pending.redirectUri !== form.get('redirect_uri') || pending.challenge !== challenge) {
        return send(res, 400, { error: 'invalid_grant', error_description: 'authentication failure' });
      }
      const refreshToken = token();
      refreshTokens.add(refreshToken);
      return send(res, 200, tokenResponse(refreshToken));
    }
    if (form.get('grant_type') === 'refresh_token') {
      if (!refreshTokens.has(form.get('refresh_token') ?? '')) {
        return send(res, 400, { error: 'invalid_grant', error_description: 'expired access/refresh token' });
      }
      return send(res, 200, tokenResponse());
    }
    return send(res, 400, { error: 'unsupported_grant_type', error_description: 'grant type not supported' });
  }

  function page(res: ServerResponse, locator: string, records: Record<string, unknown>[], type: string, offset: number) {
    const slice = records.slice(offset, offset + fake.pageSize);
    const done = offset + slice.length >= records.length;
    if (!done) cursors.set(locator, { records, type, offset: offset + slice.length });
    send(res, 200, {
      totalSize: records.length,
      done,
      ...(done ? {} : { nextRecordsUrl: `/services/data/${fake.apiVersion}/query/${locator}-${offset + slice.length}` }),
      records: slice.map((r) => ({ attributes: { type, url: `/services/data/${fake.apiVersion}/sobjects/${type}/x` }, ...r })),
    });
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    const auth = req.headers.authorization ?? '';
    if (!accessTokens.has(auth.replace(/^Bearer /, ''))) {
      return send(res, 401, [{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }]);
    }
    if (req.method !== 'GET') {
      return send(res, 405, [{ message: 'The fake org is read-only', errorCode: 'METHOD_NOT_ALLOWED' }]);
    }
    const base = `/services/data/${fake.apiVersion}`;
    const path = url.pathname;
    if (path === base || path === `${base}/`) return send(res, 200, { sobjects: `${base}/sobjects`, query: `${base}/query` });
    if (path === `${base}/sobjects`) {
      return send(res, 200, {
        encoding: 'UTF-8',
        sobjects: fake.objects.map((o) => ({ name: o.name, label: o.label ?? o.name, queryable: o.queryable ?? true, custom: false })),
      });
    }
    const describe = path.match(new RegExp(`^${base}/sobjects/([^/]+)/describe$`));
    if (describe) {
      const object = fake.objects.find((o) => o.name === describe[1]);
      if (!object) return send(res, 404, [{ message: 'The requested resource does not exist', errorCode: 'NOT_FOUND' }]);
      return send(res, 200, {
        name: object.name,
        label: object.label ?? object.name,
        fields: object.fields.map((f) => ({ nillable: true, length: 0, referenceTo: [], ...f, label: f.name })),
      });
    }
    if (path === `${base}/query`) {
      const soql = url.searchParams.get('q') ?? '';
      const found = queries.get(soql);
      if (!found) return send(res, 400, [{ message: `unexpected token: '${soql.split(' ')[0]}'`, errorCode: 'MALFORMED_QUERY' }]);
      const respond = () => page(res, token(), found.records, found.type, 0);
      if (found.delayMs > 0) setTimeout(respond, found.delayMs);
      else respond();
      return;
    }
    const more = path.match(new RegExp(`^${base}/query/([0-9a-f]+)-(\\d+)$`));
    if (more && cursors.has(more[1]!)) {
      const cursor = cursors.get(more[1]!)!;
      return page(res, more[1]!, cursor.records, cursor.type, cursor.offset);
    }
    return send(res, 404, [{ message: 'The requested resource does not exist', errorCode: 'NOT_FOUND' }]);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    fake.requests.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      ...(url.searchParams.has('q') ? { soql: url.searchParams.get('q')! } : {}),
    });
    const handle = url.pathname === '/services/oauth2/token' && req.method === 'POST' ? oauthToken(req, res) : api(req, res, url);
    handle.catch((error: unknown) => send(res, 500, [{ message: String(error), errorCode: 'UNKNOWN_EXCEPTION' }]));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
