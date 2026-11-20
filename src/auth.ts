import NextAuth from 'next-auth';
import Slack from 'next-auth/providers/slack';
import { WrongWorkspaceError } from '@/core';
import { identityFromSlackProfile } from '@/web/auth/slack-profile';
import { getCore } from '@/web/server-runtime';

/**
 * Auth.js (v5) with Slack OpenID Connect as the only provider.
 * AUTH_SLACK_ID / AUTH_SLACK_SECRET / AUTH_SECRET are read from the environment by Auth.js.
 * The workspace restriction is enforced by the App Core (`users.signIn`), not by the
 * `team` hint, which only pre-selects the workspace on Slack's consent screen.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Slack({
      authorization: { params: { scope: 'openid profile email', team: process.env.SLACK_TEAM_ID } },
    }),
  ],
  session: { strategy: 'jwt' },
  pages: { signIn: '/signin', error: '/signin' },
  callbacks: {
    async signIn({ profile }) {
      const identity = identityFromSlackProfile(profile);
      if (!identity) return false;
      try {
        await (await getCore()).users.signIn(identity);
        return true;
      } catch (error) {
        if (error instanceof WrongWorkspaceError) return false;
        throw error;
      }
    },
    async jwt({ token, profile }) {
      // `profile` is only present on the initial sign-in.
      const identity = identityFromSlackProfile(profile);
      if (identity) token.slackUserId = identity.slackUserId;
      return token;
    },
    async session({ session, token }) {
      if (typeof token.slackUserId === 'string') session.user.slackUserId = token.slackUserId;
      return session;
    },
  },
});
