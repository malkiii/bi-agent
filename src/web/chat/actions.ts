'use server';

import { notFound, redirect } from 'next/navigation';
import { NotFoundError } from '@/core';
import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';

/** "Open in dashboard": forks a Slack Conversation into a new web Conversation and opens it. */
export async function forkConversationAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get('conversationId') ?? '');
  let forkId: string;
  try {
    forkId = (await (await getCore()).conversations.fork(user.slackUserId, id)).id;
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  redirect(`/chat/${forkId}`);
}
