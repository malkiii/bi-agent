import { NextResponse, type NextRequest } from 'next/server';
import { AppError, OAuthError } from '@/core';
import { getCurrentUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';

/**
 * OAuth callback for Data Sources connected through a consent screen (Salesforce).
 * Admin-only via the proxy (/api/admin); the App Core checks again and verifies the state.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  const back = (path: string) => NextResponse.redirect(new URL(path, request.nextUrl), 303);
  if (!user) return back('/signin');

  const params = request.nextUrl.searchParams;
  try {
    const ds = await (await getCore()).dataSources.completeOAuth(user.slackUserId, {
      state: params.get('state') ?? '',
      code: params.get('code') ?? undefined,
      error: params.get('error') ?? undefined,
      errorDescription: params.get('error_description') ?? undefined,
    });
    return back(`/admin/data-sources/${ds.id}?notice=connected`);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    const id = error instanceof OAuthError ? error.dataSourceId : undefined;
    return back(`/admin/data-sources${id ? `/${id}` : ''}?error=${encodeURIComponent(error.message)}`);
  }
}
