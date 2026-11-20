import type { Db } from 'mongodb';
import type { Clock } from '../ports';
import { ForbiddenError, LastAdminError, NotFoundError, WrongWorkspaceError } from '../errors';

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
  /** Admin only: every user, sorted by name (case-insensitive). */
  list(actorSlackUserId: string): Promise<User[]>;
  /**
   * Admin only: promotes or demotes a user (admins may demote themselves).
   * Throws NotFoundError for unknown users and LastAdminError if no admin would remain.
   */
  setRole(actorSlackUserId: string, targetSlackUserId: string, role: Role): Promise<User>;
}

export function createUsers({ db, clock, config }: { db: Db; clock: Clock; config: UsersConfig }): Users {
  const users = db.collection<User>('users');
  const project = { projection: { _id: 0 } } as const;

  async function requireAdmin(slackUserId: string): Promise<User> {
    const user = await users.findOne({ slackUserId }, project);
    if (user?.role !== 'admin') throw new ForbiddenError('Admins only.');
    return user;
  }

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

    requireAdmin,

    async list(actorSlackUserId) {
      await requireAdmin(actorSlackUserId);
      return users
        .find({}, project)
        .collation({ locale: 'en', strength: 2 })
        .sort({ name: 1, slackUserId: 1 })
        .toArray();
    },

    async setRole(actorSlackUserId, targetSlackUserId, role) {
      await requireAdmin(actorSlackUserId);
      const before = await users.findOneAndUpdate(
        { slackUserId: targetSlackUserId },
        { $set: { role } },
        { returnDocument: 'before', ...project },
      );
      if (!before) throw new NotFoundError('User not found.');

      // Mongo runs standalone (no transactions), so demote first, then check that an admin
      // remains and undo if not. Concurrent demotions can then only both fail, never both win.
      if (before.role === 'admin' && role === 'member' && (await users.countDocuments({ role: 'admin' })) === 0) {
        await users.updateOne({ slackUserId: targetSlackUserId }, { $set: { role: 'admin' } });
        throw new LastAdminError();
      }
      return { ...before, role };
    },
  };
}

export async function ensureUserIndexes(db: Db) {
  await db.collection('users').createIndex({ slackUserId: 1 }, { unique: true });
}
