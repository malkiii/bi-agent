export type RouteAccess = 'public' | 'signed-in' | 'admin';

const PUBLIC = ['/signin', '/api/auth'];
const ADMIN = ['/admin', '/api/admin'];

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * Who may request a path. Enforced in src/proxy.ts on every request.
 * Put admin-only pages under /admin and admin-only API routes under /api/admin.
 */
export function routeAccess(pathname: string): RouteAccess {
  if (PUBLIC.some((p) => under(pathname, p))) return 'public';
  if (ADMIN.some((p) => under(pathname, p))) return 'admin';
  return 'signed-in';
}
