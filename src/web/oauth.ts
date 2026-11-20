import { headers } from 'next/headers';

/** Where OAuth providers (Salesforce) send the admin back. Register this URL in the provider's app. */
export const OAUTH_CALLBACK_PATH = '/api/admin/data-sources/oauth/callback';

/**
 * The absolute callback URL. Uses AUTH_URL (the https URL people open, already required for
 * Slack sign-in) so it matches what was registered, falling back to the request's host.
 */
export async function oauthCallbackUrl(): Promise<string> {
  const configured = process.env.AUTH_URL?.trim();
  if (configured) return new URL(OAUTH_CALLBACK_PATH, configured).toString();
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? 'http';
  return `${proto}://${host}${OAUTH_CALLBACK_PATH}`;
}
