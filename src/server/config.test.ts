import { describe, expect, test } from 'vitest';
import { parseServerConfig } from './config';

const minimal = { MONGO_URL: 'mongodb://mongo:27017', SLACK_TEAM_ID: 'T0TEAM' };

describe('server config from environment', () => {
  test('applies defaults', () => {
    expect(parseServerConfig(minimal)).toEqual({
      mongoUrl: 'mongodb://mongo:27017',
      mongoDb: 'botley',
      core: { slackTeamId: 'T0TEAM', adminSlackUserIds: [] },
    });
  });

  test('reads a comma-separated admin list, ignoring blanks and spaces', () => {
    const config = parseServerConfig({ ...minimal, ADMIN_SLACK_USER_IDS: ' U1, U2 ,,U3 ' });

    expect(config.core.adminSlackUserIds).toEqual(['U1', 'U2', 'U3']);
  });

  test('names every missing variable', () => {
    expect(() => parseServerConfig({})).toThrow(/MONGO_URL[\s\S]*SLACK_TEAM_ID/);
  });
});
