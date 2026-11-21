import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { ForbiddenError } from '@/core';
import { routeAccess } from '@/web/auth/route-access';
import { getCore } from '@/web/server-runtime';

/**
 * Runs on every request (Node runtime in Next 16). Signed-out visitors go to /signin;
 * /admin and /api/admin are refused (403) unless the App Core says the user is an admin.
 */
export const proxy = auth(async (req) => {
  const { pathname } = req.nextUrl;
  const access = routeAccess(pathname);
  if (access === 'public') return NextResponse.next();

  const slackUserId = req.auth?.user?.slackUserId;
  if (!slackUserId) {
    if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const signin = new URL('/signin', req.nextUrl);
    signin.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(signin);
  }

  if (access === 'admin') {
    try {
      await (await getCore()).users.requireAdmin(slackUserId);
    } catch (error) {
      if (!(error instanceof ForbiddenError)) throw error;
      if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
      return NextResponse.rewrite(new URL('/forbidden', req.nextUrl), { status: 403 });
    }
  }
  return NextResponse.next();
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|bibot.svg).*)'],
};
