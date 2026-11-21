'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { NotFoundError, ValidationError } from '@/core';
import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';

/** Admin only (checked by src/proxy.ts and the App Core): deletes a Conversation and its messages. */
export async function deleteConversationAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const id = form.get('id');
  const back = form.get('back');
  const result = new URLSearchParams({ notice: 'deleted' });
  try {
    if (typeof id === 'string') await (await getCore()).conversations.remove(user.slackUserId, id);
  } catch (error) {
    if (error instanceof NotFoundError) {
      result.set('notice', 'gone'); // Already deleted, e.g. in another tab.
    } else if (error instanceof ValidationError) {
      result.delete('notice');
      result.set('error', error.message); // Still used by a Report or draft KPI.
    } else {
      throw error;
    }
  }
  revalidatePath('/admin/conversations');
  revalidatePath('/history');
  const target = typeof back === 'string' && back.startsWith('/admin/conversations') ? back : '/admin/conversations';
  redirect(`${target}${target.includes('?') ? '&' : '?'}${result}`);
}
