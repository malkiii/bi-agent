import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import type { User } from '@/core';
import { getCore } from './server-runtime';

/** The signed-in user (fresh from Mongo, so role changes apply immediately), or null. */
export async function getCurrentUser(): Promise<User | null> {
  const session = await auth();
  const slackUserId = session?.user?.slackUserId;
  if (!slackUserId) return null;
  return (await getCore()).users.get(slackUserId);
}

/** For server components and actions that need a user: redirects to /signin otherwise. */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect('/signin');
  return user;
}
