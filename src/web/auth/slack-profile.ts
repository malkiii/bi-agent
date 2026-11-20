import type { SlackIdentity } from '@/core';

/** Extracts the identity we care about from Slack's OpenID Connect claims. */
export function identityFromSlackProfile(profile: Record<string, unknown> | null | undefined): SlackIdentity | null {
  if (!profile) return null;
  const str = (key: string) => (typeof profile[key] === 'string' && profile[key] ? (profile[key] as string) : null);
  const slackUserId = str('https://slack.com/user_id');
  const slackTeamId = str('https://slack.com/team_id');
  if (!slackUserId || !slackTeamId) return null;
  return {
    slackUserId,
    slackTeamId,
    name: str('name') ?? slackUserId,
    email: str('email'),
    image: str('picture'),
  };
}
