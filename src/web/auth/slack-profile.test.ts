import { expect, test } from 'vitest';
import { identityFromSlackProfile } from './slack-profile';

test('maps Slack OIDC claims to a Slack identity', () => {
  const identity = identityFromSlackProfile({
    sub: 'U123',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    picture: 'https://avatars.slack-edge.com/ada.png',
    'https://slack.com/user_id': 'U123',
    'https://slack.com/team_id': 'T0TEAM',
  });

  expect(identity).toEqual({
    slackUserId: 'U123',
    slackTeamId: 'T0TEAM',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    image: 'https://avatars.slack-edge.com/ada.png',
  });
});

test('returns null when the workspace or user claim is missing', () => {
  expect(identityFromSlackProfile({ sub: 'U123', name: 'Ada' })).toBeNull();
  expect(identityFromSlackProfile(undefined)).toBeNull();
});
