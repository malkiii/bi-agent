'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { AppError, type ConfirmUploadInput } from '@/core';
import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';

/** Thin adapters over `core.uploads`; the App Core validates and checks roles. */

export type ConfirmUploadResult = { ok: true; datasetIds: string[] } | { ok: false; error: string };

/** Step 2 of an upload: store the previewed sheets with the member's corrections. */
export async function confirmUploadAction(input: ConfirmUploadInput): Promise<ConfirmUploadResult> {
  const user = await requireUser();
  try {
    const stored = await (await getCore()).uploads.confirm(user.slackUserId, input);
    revalidatePath('/uploads');
    revalidatePath('/catalog');
    return { ok: true, datasetIds: stored.map((d) => d.datasetId) };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: error.message };
    throw error;
  }
}

/** Admins only (checked by the App Core). */
export async function deleteUploadAction(formData: FormData) {
  const user = await requireUser();
  const datasetId = String(formData.get('datasetId') ?? '');
  let query = 'notice=deleted';
  try {
    await (await getCore()).uploads.delete(user.slackUserId, datasetId);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    query = `error=${encodeURIComponent(error.message)}`;
  }
  revalidatePath('/uploads');
  revalidatePath('/catalog');
  redirect(`/uploads?${query}`);
}
