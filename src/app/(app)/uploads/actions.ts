'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { AppError } from '@/core';
import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';

/** Admin only (the App Core checks): deletes an uploaded Dataset and its file. */
export async function deleteUploadedDataset(formData: FormData) {
  const user = await requireUser();
  try {
    await (await getCore()).uploads.delete(user.slackUserId, String(formData.get('id')));
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    redirect(`/uploads?error=${encodeURIComponent(error.message)}`);
  }
  revalidatePath('/uploads');
  redirect('/uploads');
}
