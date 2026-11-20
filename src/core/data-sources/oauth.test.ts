import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ForbiddenError, OAuthError, QueryFailedError, ValidationError } from '@/core';
import { createTestHarness, type TestHarness } from '@/core/testing';
import { CONTRACT_FIXTURE_OBJECT, startFakeSalesforce, type FakeSalesforce } from '@/drivers/salesforce/testing';

/** Connecting a Salesforce org through OAuth (authorization code + PKCE), via the App Core. */

const ADMIN = 'UADMIN';
const OTHER_ADMIN = 'UADMIN2';
const MEMBER = 'UMEMBER';
const REDIRECT = 'https://botley.internal/api/admin/data-sources/oauth/callback';

let h: TestHarness;
let sf: FakeSalesforce;
beforeEach(async () => {
  sf = await startFakeSalesforce();
  sf.objects.push(CONTRACT_FIXTURE_OBJECT);
  sf.soql('SELECT region FROM orders', [{ region: 'north' }]);
  h = await createTestHarness({ config: { slackTeamId: 'T1', adminSlackUserIds: [ADMIN, OTHER_ADMIN] } });
  for (const slackUserId of [ADMIN, OTHER_ADMIN, MEMBER]) {
    await h.core.users.signIn({ slackUserId, slackTeamId: 'T1', name: slackUserId, email: null, image: null });
  }
});
afterEach(async () => {
  await h.close();
  await sf.close();
});

function salesforceInput(overrides: { clientId?: string; clientSecret?: string } = {}) {
  return {
    name: 'CRM',
    kind: 'salesforce',
    config: { loginUrl: sf.url, clientId: overrides.clientId ?? sf.clientId, apiVersion: sf.apiVersion },
    secrets: { clientSecret: overrides.clientSecret ?? sf.clientSecret },
  };
}

/** Plays the whole browser round trip: Botley -> Salesforce consent -> callback. */
async function connect(id: string, actor = ADMIN) {
  const { url } = await h.core.dataSources.startOAuth(actor, id, { redirectUri: REDIRECT });
  const code = sf.approve(url);
  return h.core.dataSources.completeOAuth(actor, { state: new URL(url).searchParams.get('state')!, code });
}

describe('connecting Salesforce through OAuth', () => {
  test('a new Salesforce Data Source is not connected and says so when tested', async () => {
    const ds = await h.core.dataSources.create(ADMIN, salesforceInput());

    expect(ds).toMatchObject({ kind: 'salesforce', connected: false, secrets: { clientSecret: true } });
    const result = await h.core.dataSources.testConnection(ADMIN, { ...salesforceInput(), id: ds.id, secrets: {} });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Connect to Salesforce/) });
  });

  test('the connect URL is Salesforce consent with PKCE (S256), our callback and the api + refresh_token scopes', async () => {
    const ds = await h.core.dataSources.create(ADMIN, salesforceInput());

    const { url } = await h.core.dataSources.startOAuth(ADMIN, ds.id, { redirectUri: REDIRECT });

    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(`${sf.url}/services/oauth2/authorize`);
    expect(Object.fromEntries(parsed.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: sf.clientId,
      redirect_uri: REDIRECT,
      scope: 'api refresh_token',
      code_challenge_method: 'S256',
      code_challenge: expect.stringMatching(/^[\w-]{43}$/),
      state: expect.stringMatching(/^[\w-]{20,}$/),
    });
  });

  test('completing the flow stores the tokens encrypted; the Data Source then works', async () => {
    const ds = await h.core.dataSources.create(ADMIN, salesforceInput());

    const connected = await connect(ds.id);

    expect(connected).toMatchObject({ connected: true });
    expect(JSON.stringify(connected)).not.toMatch(/Token|instanceUrl/);
    expect(await h.core.dataSources.testConnection(ADMIN, { ...salesforceInput(), id: ds.id, secrets: {} })).toEqual({
      ok: true,
    });
    const refreshed = await h.core.dataSources.refreshSchema(ADMIN, ds.id);
    expect(refreshed.datasets.map((d) => d.id)).toEqual(['orders']);

    const stored = JSON.stringify(await h.db.collection('dataSources').find().toArray());
    expect(stored).not.toContain(sf.clientSecret);  });

  test('a refreshed access token is persisted, so the next driver does not refresh again', async () => {
    const ds = await h.core.dataSources.create(ADMIN, salesforceInput());
    await connect(ds.id);
    sf.expireAccessTokens();
    const refreshes = () => sf.requests.filter((r) => r.path === '/services/oauth2/token').length;
    const before = refreshes();

    await h.core.dataSources.withDriver(ds.id, (d) => d.execute('SELECT region FROM orders'));
    await h.core.dataSources.withDriver(ds.id, (d) => d.execute('SELECT region FROM orders'));

    expect(refreshes()).toBe(before + 1);
  });

  test('a revoked refresh token surfaces as a readable error asking to reconnect', async () => {
    const ds = await h.core.dataSources.create(ADMIN, salesforceInput());
    await connect(ds.id);
    sf.expireAccessTokens();
    sf.revokeRefreshTokens();

    const run = h.core.dataSources.withDriver(ds.id, (d) => d.execute('SELECT region FROM orders'));

    await expect(run).rejects.toThrow(QueryFailedError);
    await expect(run).rejects.toThrow(/invalid_grant.*Reconnect/);
  });

  test('a callback reporting that the admin denied access fails with the reason and the Data Source id', async () => {
    const ds = await h.core.dataSources.create(ADMIN, salesforceInput());
    const { url } = await h.core.dataSources.startOAuth(ADMIN, ds.id, { redirectUri: REDIRECT });

    const error = await h.core.dataSources
      .completeOAuth(ADMIN, {
        state: new URL(url).searchParams.get('state')!,
        error: 'access_denied',
        errorDescription: 'end-user denied authorization',
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OAuthError);
    expect(error).toMatchObject({ dataSourceId: ds.id, message: expect.stringMatching(/denied/) });
  });

  test('a wrong consumer secret fails the code exchange with a readable OAuthError', async () => {
    const ds = await h.core.dataSources.create(ADMIN, salesforceInput({ clientSecret: 'wrong' }));

    await expect(connect(ds.id)).rejects.toThrow(/Salesforce refused the connection \(invalid_client/);
    expect((await h.core.dataSources.get(ds.id)).connected).toBe(false);
  });

  test('a state is single-use, expires after 10 minutes and is bound to the admin who started it', async () => {
    const ds = await h.core.dataSources.create(ADMIN, salesforceInput());
    const start = async () => {
      const { url } = await h.core.dataSources.startOAuth(ADMIN, ds.id, { redirectUri: REDIRECT });
      return { state: new URL(url).searchParams.get('state')!, code: sf.approve(url) };
    };

    const used = await start();
    await h.core.dataSources.completeOAuth(ADMIN, used);
    await expect(h.core.dataSources.completeOAuth(ADMIN, used)).rejects.toThrow(OAuthError);

    const late = await start();
    h.clock.advance(10 * 60_000 + 1);
    await expect(h.core.dataSources.completeOAuth(ADMIN, late)).rejects.toThrow(OAuthError);

    const stolen = await start();
    await expect(h.core.dataSources.completeOAuth(OTHER_ADMIN, stolen)).rejects.toThrow(OAuthError);
    await expect(h.core.dataSources.completeOAuth(ADMIN, { state: 'made-up', code: 'x' })).rejects.toThrow(OAuthError);
  });

  test('only admins can connect', async () => {
    const ds = await h.core.dataSources.create(ADMIN, salesforceInput());

    await expect(h.core.dataSources.startOAuth(MEMBER, ds.id, { redirectUri: REDIRECT })).rejects.toThrow(ForbiddenError);
    await expect(h.core.dataSources.completeOAuth(MEMBER, { state: 's', code: 'c' })).rejects.toThrow(ForbiddenError);
  });

  test('kinds without OAuth cannot start a connect flow', async () => {
    const ds = await h.core.dataSources.create(ADMIN, {
      name: 'Warehouse',
      kind: 'postgres',
      config: { host: 'localhost', port: 5432, database: 'x', user: 'x', sslMode: 'disable' },
      secrets: { password: 'x' },
    });

    expect(ds.connected).toBeUndefined();
    await expect(h.core.dataSources.startOAuth(ADMIN, ds.id, { redirectUri: REDIRECT })).rejects.toThrow(ValidationError);
  });

  test('editing the name keeps the connection; pointing at another app or org drops the tokens', async () => {
    const ds = await h.core.dataSources.create(ADMIN, salesforceInput());
    await connect(ds.id);

    const renamed = await h.core.dataSources.update(ADMIN, ds.id, { ...salesforceInput(), name: 'Sales CRM', secrets: {} });
    expect(renamed).toMatchObject({ name: 'Sales CRM', connected: true });

    const moved = await h.core.dataSources.update(ADMIN, ds.id, { ...salesforceInput({ clientId: 'other-app' }), secrets: {} });
    expect(moved).toMatchObject({ connected: false, secrets: { clientSecret: true } });
  });
});
