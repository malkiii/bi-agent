'use server';

import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { NotFoundError, ValidationError } from '@/core';
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

/**
 * Deletes a Conversation for everyone (any Participant may). `back` is the page the button was
 * on: /history (with its filters) goes back there; a Conversation page goes to /history once its
 * Conversation is gone, or back to it with the error when a Report or draft KPI still uses it.
 */
export async function deleteConversationAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get('conversationId') ?? '');
  const back = String(formData.get('back') ?? '');
  const from = back.startsWith('/history') || back === `/chat/${id}` ? back : '/history';
  let target = from.startsWith('/chat/') ? '/history' : from;
  const result = new URLSearchParams({ notice: 'deleted' });
  try {
    await (await getCore()).conversations.remove(user.slackUserId, id);
  } catch (error) {
    if (error instanceof NotFoundError) {
      result.set('notice', 'gone'); // Already deleted, e.g. in another tab.
    } else if (error instanceof ValidationError) {
      result.delete('notice');
      result.set('error', error.message);
      target = from;
    } else {
      throw error;
    }
  }
  revalidatePath('/history');
  revalidatePath('/');
  redirect(`${target}${target.includes('?') ? '&' : '?'}${result}`);
}
