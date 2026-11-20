import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: { slackUserId: string } & DefaultSession['user'];
  }
}
