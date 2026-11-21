'use server';

import { revalidatePath } from 'next/cache';
import { AppError, ValidationError } from '@/core';
import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';

export interface ChannelDefaultFormState {
  message?: string;
  fieldErrors?: Record<string, string>;
  saved?: boolean;
}

/** Sets a Channel Default. /admin is admin-only in the proxy, and `channelDefaults.set` checks again. */
export async function saveChannelDefaultAction(_prev: ChannelDefaultFormState, form: FormData): Promise<ChannelDefaultFormState> {
  const user = await requireUser();
  const channel = String(form.get('channel') ?? '');
  const dataSourceIds = form.getAll('dataSourceIds').map(String);
  try {
    await (await getCore()).channelDefaults.set(user.slackUserId, channel, dataSourceIds);
  } catch (error) {
    if (error instanceof ValidationError) return { message: error.message, fieldErrors: { ...error.fieldErrors } };
    if (error instanceof AppError) return { message: error.message };
    throw error;
  }
  revalidatePath('/admin/channels');
  return { saved: true };
}

export async function removeChannelDefaultAction(form: FormData): Promise<void> {
  const user = await requireUser();
  await (await getCore()).channelDefaults.remove(user.slackUserId, String(form.get('channel') ?? ''));
  revalidatePath('/admin/channels');
}
