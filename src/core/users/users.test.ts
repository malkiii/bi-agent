import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ForbiddenError, LastAdminError, NotFoundError, WrongWorkspaceError } from '@/core';
import { createTestHarness, type TestHarness } from '@/core/testing';

const TEAM = 'T0TEAM';

function identity(slackUserId: string, slackTeamId = TEAM) {
  return {
    slackUserId,
    slackTeamId,
    name: `User ${slackUserId}`,
    email: `${slackUserId.toLowerCase()}@example.com`,
    image: null,
  };
}

describe('Slack sign-in', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createTestHarness({
      config: { slackTeamId: TEAM, adminSlackUserIds: ['UADMIN'] },
    });
  });
  afterEach(() => h.close());

  test('first sign-in of a configured admin creates an admin', async () => {
    const user = await h.core.users.signIn(identity('UADMIN'));

    expect(user).toMatchObject({ slackUserId: 'UADMIN', role: 'admin', name: 'User UADMIN' });
    expect(await h.core.users.get('UADMIN')).toMatchObject({ role: 'admin' });
  });

  test('first sign-in of anyone else creates a member', async () => {
    const user = await h.core.users.signIn(identity('UBOB'));

    expect(user).toMatchObject({ slackUserId: 'UBOB', role: 'member' });
  });

  test('a user from another workspace is refused and not stored', async () => {
    await expect(h.core.users.signIn(identity('UADMIN', 'T0OTHER'))).rejects.toThrow(WrongWorkspaceError);

    expect(await h.core.users.get('UADMIN')).toBeNull();
  });

  test('signing in again refreshes the profile and keeps the role', async () => {
    const first = await h.core.users.signIn(identity('UBOB'));
    h.clock.advance(60_000);

    const again = await h.core.users.signIn({ ...identity('UBOB'), name: 'Bob Renamed' });

    expect(again).toMatchObject({ role: 'member', name: 'Bob Renamed', createdAt: first.createdAt });
    expect(again.lastSignInAt).toEqual(new Date(first.lastSignInAt.getTime() + 60_000));
  });
});

describe('admin-only actions', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createTestHarness({
      config: { slackTeamId: TEAM, adminSlackUserIds: ['UADMIN'] },
    });
    await h.core.users.signIn(identity('UADMIN'));
    await h.core.users.signIn(identity('UBOB'));
  });
  afterEach(() => h.close());

  test('are allowed for admins', async () => {
    await expect(h.core.users.requireAdmin('UADMIN')).resolves.toMatchObject({ role: 'admin' });
  });

  test('are refused for members', async () => {
    await expect(h.core.users.requireAdmin('UBOB')).rejects.toThrow(ForbiddenError);
  });

  test('are refused for unknown users', async () => {
    await expect(h.core.users.requireAdmin('UNOBODY')).rejects.toThrow(ForbiddenError);
  });
});

describe('user list', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createTestHarness({
      config: { slackTeamId: TEAM, adminSlackUserIds: ['UADMIN'] },
    });
  });
  afterEach(() => h.close());

  test('admins see every user with role and last sign-in, sorted by name', async () => {
    await h.core.users.signIn({ ...identity('UADMIN'), name: 'Ada' });
    h.clock.advance(60_000);
    await h.core.users.signIn({ ...identity('UCAROL'), name: 'carol' });
    h.clock.advance(60_000);
    await h.core.users.signIn({ ...identity('UBOB'), name: 'Bob' });

    const list = await h.core.users.list('UADMIN');

    expect(list.map((u) => [u.name, u.role, u.lastSignInAt.toISOString()])).toEqual([
      ['Ada', 'admin', '2026-01-05T09:00:00.000Z'],
      ['Bob', 'member', '2026-01-05T09:02:00.000Z'],
      ['carol', 'member', '2026-01-05T09:01:00.000Z'],
    ]);
  });

  test('members cannot see the user list', async () => {
    await h.core.users.signIn(identity('UBOB'));

    await expect(h.core.users.list('UBOB')).rejects.toThrow(ForbiddenError);
  });
});

describe('changing roles', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createTestHarness({
      config: { slackTeamId: TEAM, adminSlackUserIds: ['UADMIN'] },
    });
    await h.core.users.signIn(identity('UADMIN'));
    await h.core.users.signIn(identity('UBOB'));
  });
  afterEach(() => h.close());

  test('an admin can promote a member to admin', async () => {
    const bob = await h.core.users.setRole('UADMIN', 'UBOB', 'admin');

    expect(bob).toMatchObject({ slackUserId: 'UBOB', role: 'admin' });
    await expect(h.core.users.requireAdmin('UBOB')).resolves.toMatchObject({ role: 'admin' });
  });

  test('an admin can demote another admin', async () => {
    await h.core.users.setRole('UADMIN', 'UBOB', 'admin');

    await h.core.users.setRole('UBOB', 'UADMIN', 'member');

    expect(await h.core.users.get('UADMIN')).toMatchObject({ role: 'member' });
    await expect(h.core.users.requireAdmin('UADMIN')).rejects.toThrow(ForbiddenError);
  });

  test('an admin can step down while another admin remains', async () => {
    await h.core.users.setRole('UADMIN', 'UBOB', 'admin');

    await h.core.users.setRole('UADMIN', 'UADMIN', 'member');

    expect(await h.core.users.get('UADMIN')).toMatchObject({ role: 'member' });
  });

  test('the last admin cannot be demoted', async () => {
    await expect(h.core.users.setRole('UADMIN', 'UADMIN', 'member')).rejects.toThrow(LastAdminError);

    expect(await h.core.users.get('UADMIN')).toMatchObject({ role: 'admin' });
  });

  test('two admins demoting each other at once leaves at least one admin', async () => {
    await h.core.users.setRole('UADMIN', 'UBOB', 'admin');

    const results = await Promise.allSettled([
      h.core.users.setRole('UADMIN', 'UBOB', 'member'),
      h.core.users.setRole('UBOB', 'UADMIN', 'member'),
    ]);

    const admins = (await h.core.users.list('UADMIN').catch(() => h.core.users.list('UBOB'))).filter(
      (u) => u.role === 'admin',
    );
    expect(admins.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.status === 'rejected')).toBe(true);
  });

  test('members cannot change roles', async () => {
    await expect(h.core.users.setRole('UBOB', 'UBOB', 'admin')).rejects.toThrow(ForbiddenError);

    expect(await h.core.users.get('UBOB')).toMatchObject({ role: 'member' });
  });

  test('changing the role of an unknown user is not found', async () => {
    await expect(h.core.users.setRole('UADMIN', 'UNOBODY', 'admin')).rejects.toThrow(NotFoundError);
  });
});
