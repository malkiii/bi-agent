'use server';

import { revalidatePath } from 'next/cache';
import { AppError, ValidationError } from '@/core';
import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';

export interface LlmFormState {
  message?: string;
  fieldErrors?: Record<string, string>;
  saved?: boolean;
}

/** Sets the active LLM. /admin is admin-only in the proxy, and `llmSettings.set` checks again. */
export async function saveLlmSettings(_prev: LlmFormState, formData: FormData): Promise<LlmFormState> {
  const user = await requireUser();
  try {
    await (await getCore()).llmSettings.set(user.slackUserId, {
      provider: String(formData.get('provider') ?? ''),
      model: String(formData.get('model') ?? ''),
    });
  } catch (error) {
    if (error instanceof ValidationError) return { message: error.message, fieldErrors: { ...error.fieldErrors } };
    if (error instanceof AppError) return { message: error.message };
    throw error;
  }
  revalidatePath('/admin/settings');
  return { saved: true };
}
