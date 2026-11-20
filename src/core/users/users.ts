import type { Db } from 'mongodb';
import type { Clock } from '../ports';
import { ForbiddenError, WrongWorkspaceError } from '../errors';

export type Role = 'admin' | 'member';

export interface User {
  slackUserId: string;
  slackTeamId: string;
  name: string;
  email: string | null;
  image: string | null;
  role: Role;
  createdAt: Date;
  lastSignInAt: Date;
}

/** What Slack OIDC tells us about the person signing in. */
export interface SlackIdentity {
  slackUserId: string;
  slackTeamId: string;
  name: string;
  email: string | null;
  image: string | null;
}

export interface UsersConfig {
  slackTeamId: string;
  adminSlackUserIds: readonly string[];
}

export interface Users {
  /**
   * Records a Slack sign-in. Refuses other workspaces with WrongWorkspaceError.
   * The first sign-in creates the user: admin if listed in ADMIN_SLACK_USER_IDS, else member.
   * Later sign-ins refresh the profile but never change the role.
   */
  signIn(identity: SlackIdentity): Promise<User>;
  get(slackUserId: string): Promise<User | null>;
  /** Returns the user if they are an admin; throws ForbiddenError otherwise. */
  requireAdmin(slackUserId: string): Promise<User>;
}

export function createUsers({ db, clock, config }: { db: Db; clock: Clock; config: UsersConfig }): Users {
  const users = db.collection<User>('users');
  const project = { projection: { _id: 0 } } as const;

  return {
    async signIn(identity) {
      if (identity.slackTeamId !== config.slackTeamId) throw new WrongWorkspaceError();
      const now = clock.now();
      const role: Role = config.adminSlackUserIds.includes(identity.slackUserId) ? 'admin' : 'member';
      const user = await users.findOneAndUpdate(
        { slackUserId: identity.slackUserId },
        {
          $set: {
            slackTeamId: identity.slackTeamId,
            name: identity.name,
            email: identity.email,
            image: identity.image,
            lastSignInAt: now,
          },
          $setOnInsert: { slackUserId: identity.slackUserId, role, createdAt: now },
        },
        { upsert: true, returnDocument: 'after', ...project },
      );
      return user!;
    },

    get(slackUserId) {
      return users.findOne({ slackUserId }, project);
    },

    async requireAdmin(slackUserId) {
      const user = await users.findOne({ slackUserId }, project);
      if (user?.role !== 'admin') throw new ForbiddenError('Admins only.');
      return user;
    },
  };
}

export async function ensureUserIndexes(db: Db) {
  await db.collection('users').createIndex({ slackUserId: 1 }, { unique: true });
}
