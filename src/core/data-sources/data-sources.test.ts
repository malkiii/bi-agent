import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { ForbiddenError, NotFoundError, ValidationError } from '@/core';
import { createTestHarness, type TestHarness } from '@/core/testing';
import type { PostgresConnection } from '@/drivers/postgres/postgres';
import { CONTRACT_FIXTURE_SQL, createPostgresTestDatabase, type PostgresTestDatabase } from '@/drivers/postgres/testing';

const ADMIN = 'UADMIN';
const MEMBER = 'UMEMBER';

let pgDb: PostgresTestDatabase;
/** A read-only login, as the form tells admins to use. */
let readOnly: PostgresConnection;
beforeAll(async () => {
  pgDb = await createPostgresTestDatabase();
  await pgDb.sql(CONTRACT_FIXTURE_SQL);
  readOnly = await pgDb.createReadOnlyUser();
});
afterAll(() => pgDb.drop());

let h: TestHarness;
beforeEach(async () => {
  h = await createTestHarness({ config: { slackTeamId: 'T1', adminSlackUserIds: [ADMIN] } });
  for (const slackUserId of [ADMIN, MEMBER]) {
    await h.core.users.signIn({ slackUserId, slackTeamId: 'T1', name: slackUserId, email: null, image: null });
  }
});
afterEach(() => h.close());

function postgresInput(
  overrides: { password?: string; name?: string; database?: string } = {},
  connection: PostgresConnection = readOnly,
) {
  const { host, port, database, user, password } = connection;
  return {
    name: overrides.name ?? 'Warehouse',
    kind: 'postgres',
    config: { host, port, database: overrides.database ?? database, user, sslMode: 'disable' },
    secrets: { password: overrides.password ?? password },
  };
}

describe('managing Data Sources', () => {
  test('an admin creates a Postgres Data Source; its password is reported as set, never returned', async () => {
    const created = await h.core.dataSources.create(ADMIN, postgresInput());

    expect(created).toMatchObject({
      name: 'Warehouse',
      kind: 'postgres',
      config: { host: readOnly.host, port: readOnly.port, user: readOnly.user },
      secrets: { password: true },
      datasets: [],
    });
    expect(JSON.stringify(created)).not.toContain(readOnly.password);
    expect(await h.core.dataSources.list()).toEqual([created]);
    expect(await h.core.dataSources.get(created.id)).toEqual(created);
  });

  test('credentials are encrypted at rest', async () => {
    const password = 'pa55-unique-' + Math.random().toString(36).slice(2);
    await h.core.dataSources.create(ADMIN, postgresInput({ password }));

    const stored = await h.db.collection('dataSources').find().toArray();
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(password);
  });

  test('members cannot create, edit, delete, test or introspect Data Sources', async () => {
    const ds = await h.core.dataSources.create(ADMIN, postgresInput());

    await expect(h.core.dataSources.create(MEMBER, postgresInput({ name: 'Other' }))).rejects.toThrow(ForbiddenError);
    await expect(h.core.dataSources.update(MEMBER, ds.id, postgresInput())).rejects.toThrow(ForbiddenError);
    await expect(h.core.dataSources.delete(MEMBER, ds.id)).rejects.toThrow(ForbiddenError);
    await expect(h.core.dataSources.testConnection(MEMBER, postgresInput())).rejects.toThrow(ForbiddenError);
    await expect(h.core.dataSources.refreshSchema(MEMBER, ds.id)).rejects.toThrow(ForbiddenError);
    await expect(h.core.dataSources.setExposedDatasets(MEMBER, ds.id, [])).rejects.toThrow(ForbiddenError);
    expect(await h.core.dataSources.list()).toHaveLength(1);
  });

  test('invalid settings are refused with a message per field', async () => {
    const input = postgresInput();
    const bad = { ...input, config: { ...input.config, host: '', port: 'abc' }, secrets: {} };

    const error = await h.core.dataSources.create(ADMIN, bad).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).fieldErrors).toMatchObject({
      host: expect.any(String),
      port: expect.any(String),
      password: expect.any(String),
    });
  });

  test('unknown kinds and duplicate names are refused', async () => {
    await h.core.dataSources.create(ADMIN, postgresInput());

    await expect(h.core.dataSources.create(ADMIN, { ...postgresInput({ name: 'X' }), kind: 'oracle' })).rejects.toThrow(
      ValidationError,
    );
    await expect(h.core.dataSources.create(ADMIN, postgresInput())).rejects.toThrow(/already exists/);
  });

  test('editing without a password keeps the stored one; a new password replaces it', async () => {
    const ds = await h.core.dataSources.create(ADMIN, postgresInput({ password: 'wrong' }));
    expect(await h.core.dataSources.testConnection(ADMIN, { ...postgresInput(), id: ds.id, secrets: {} })).toMatchObject({
      ok: false,
    });

    await h.core.dataSources.update(ADMIN, ds.id, postgresInput());
    const renamed = await h.core.dataSources.update(ADMIN, ds.id, { ...postgresInput({ name: 'Renamed' }), secrets: {} });

    expect(renamed).toMatchObject({ name: 'Renamed', secrets: { password: true } });
    expect(await h.core.dataSources.testConnection(ADMIN, { ...postgresInput(), id: ds.id, secrets: {} })).toEqual({
      ok: true,
    });
  });

  test('an admin deletes a Data Source', async () => {
    const ds = await h.core.dataSources.create(ADMIN, postgresInput());

    await h.core.dataSources.delete(ADMIN, ds.id);

    expect(await h.core.dataSources.list()).toEqual([]);
    await expect(h.core.dataSources.get(ds.id)).rejects.toThrow(NotFoundError);
  });
});

describe('testing a connection', () => {
  test('succeeds for good unsaved settings', async () => {
    expect(await h.core.dataSources.testConnection(ADMIN, postgresInput())).toEqual({ ok: true });
  });

  test('reports a readable error for bad settings', async () => {
    expect(await h.core.dataSources.testConnection(ADMIN, postgresInput({ database: 'missing_db' }))).toEqual({
      ok: false,
      error: expect.stringMatching(/missing_db.*does not exist/),
    });
  });
});

describe('introspection and Exposed Datasets', () => {
  test('refreshing the schema lists Datasets, none exposed until an admin picks them', async () => {
    const ds = await h.core.dataSources.create(ADMIN, postgresInput());

    const refreshed = await h.core.dataSources.refreshSchema(ADMIN, ds.id);

    expect(refreshed.schemaRefreshedAt).toEqual(h.clock.now());
    expect(refreshed.datasets).toEqual([
      {
        id: 'public.orders',
        name: 'orders',
        schema: 'public',
        kind: 'table',
        exposed: false,
        columns: [
          { name: 'id', type: 'integer', nativeType: 'integer', nullable: false },
          { name: 'region', type: 'string', nativeType: 'text', nullable: false },
          { name: 'amount', type: 'number', nativeType: 'numeric(10,2)', nullable: false },
        ],
      },
    ]);

    const exposed = await h.core.dataSources.setExposedDatasets(ADMIN, ds.id, ['public.orders']);
    expect(exposed.datasets.map((d) => [d.id, d.exposed])).toEqual([['public.orders', true]]);
  });

  test('refreshing again keeps choices, adds new Datasets unexposed and drops removed ones', async () => {
    const db = await createPostgresTestDatabase();
    try {
      await db.sql('CREATE TABLE a (x int); CREATE TABLE b (y int);');
      const ds = await h.core.dataSources.create(ADMIN, postgresInput({}, db.connection));
      await h.core.dataSources.refreshSchema(ADMIN, ds.id);
      await h.core.dataSources.setExposedDatasets(ADMIN, ds.id, ['public.a', 'public.b']);

      await db.sql('DROP TABLE b; CREATE TABLE c (z int);');
      const refreshed = await h.core.dataSources.refreshSchema(ADMIN, ds.id);

      expect(refreshed.datasets.map((d) => [d.id, d.exposed])).toEqual([
        ['public.a', true],
        ['public.c', false],
      ]);
    } finally {
      await db.drop();
    }
  });

  test('exposing a Dataset that introspection did not find is refused', async () => {
    const ds = await h.core.dataSources.create(ADMIN, postgresInput());
    await h.core.dataSources.refreshSchema(ADMIN, ds.id);

    await expect(h.core.dataSources.setExposedDatasets(ADMIN, ds.id, ['public.nope'])).rejects.toThrow(ValidationError);
  });
});

describe('querying through a Data Source', () => {
  test('withDriver runs read-only queries with the decrypted credentials', async () => {
    const ds = await h.core.dataSources.create(ADMIN, postgresInput());

    const result = await h.core.dataSources.withDriver(ds.id, (driver) =>
      driver.execute('SELECT count(*) AS n FROM orders'),
    );

    expect(result.rows).toEqual([[3]]);
  });
});
