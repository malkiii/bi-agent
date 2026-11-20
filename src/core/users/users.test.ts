import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ForbiddenError, WrongWorkspaceError } from '@/core';
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
