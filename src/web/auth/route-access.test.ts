import { describe, expect, test } from 'vitest';
import { routeAccess } from './route-access';

describe('route access', () => {
  test.each([
    ['/signin', 'public'],
    ['/api/auth/callback/slack', 'public'],
    ['/', 'signed-in'],
    ['/conversations/abc', 'signed-in'],
    ['/admin', 'admin'],
    ['/admin/users', 'admin'],
    ['/api/admin/roles', 'admin'],
    ['/administrator', 'signed-in'],
  ] as const)('%s is %s', (path, expected) => {
    expect(routeAccess(path)).toBe(expected);
  });
});
