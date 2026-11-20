'use server';

import { revalidatePath } from 'next/cache';
import { AppError, ValidationError } from '@/core';
import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';

/** LLM settings actions. /admin is admin-only in the proxy, and the App Core checks again. */

export interface LlmFormState {
  message?: string;
  saved?: boolean;
  fieldErrors?: Record<string, string>;
}

function toState(error: unknown): LlmFormState {
  if (error instanceof ValidationError) return { message: error.message, fieldErrors: { ...error.fieldErrors } };
  if (error instanceof AppError) return { message: error.message };
  throw error;
}

export async function saveLlmSettings(_prev: LlmFormState, formData: FormData): Promise<LlmFormState> {
  const user = await requireUser();
  const llmSettings = (await getCore()).llmSettings;
  try {
    if (formData.get('intent') === 'reset') await llmSettings.reset(user.slackUserId);
    else {
      await llmSettings.set(user.slackUserId, {
        provider: String(formData.get('provider') ?? ''),
        model: String(formData.get('model') ?? ''),
      });
    }
  } catch (error) {
    return toState(error);
  }
  revalidatePath('/admin/llm');
  return { saved: true };
}
