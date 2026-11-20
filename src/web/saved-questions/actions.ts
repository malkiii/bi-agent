'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { AppError, type PinnedRunBlock, type SavedQuestionVisibility } from '@/core';
import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';

/** Thin adapters over `core.savedQuestions`; the App Core enforces ownership and visibility. */

export type SaveQuestionResult = { ok: true; id: string } | { ok: false; error: string };

export async function saveQuestionAction(input: {
  conversationId: string;
  answerMessageId: string;
  visibility: SavedQuestionVisibility;
}): Promise<SaveQuestionResult> {
  const user = await requireUser();
  try {
    const saved = await (await getCore()).savedQuestions.save(user.slackUserId, input);
    revalidatePath('/questions');
    return { ok: true, id: saved.id };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: error.message };
    throw error;
  }
}

/** A re-run as the browser gets it: no raw results, ISO dates. */
export type RunResult =
  | { ok: true; status: 'complete' | 'failed'; error?: string; blocks: PinnedRunBlock[]; finishedAt: string }
  | { ok: false; error: string };

export async function runSavedQuestionAction(id: string): Promise<RunResult> {
  const user = await requireUser();
  try {
    const run = await (await getCore()).savedQuestions.run(user.slackUserId, id);
    return {
      ok: true,
      status: run.status,
      ...(run.error ? { error: run.error } : {}),
      blocks: run.blocks,
      finishedAt: run.finishedAt.toISOString(),
    };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function setVisibilityAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(form.get('id') ?? '');
  const visibility = form.get('visibility') === 'shared' ? 'shared' : 'private';
  await (await getCore()).savedQuestions.update(user.slackUserId, id, { visibility });
  revalidatePath('/questions');
  revalidatePath(`/questions/${id}`);
}

export async function deleteSavedQuestionAction(form: FormData): Promise<void> {
  const user = await requireUser();
  await (await getCore()).savedQuestions.delete(user.slackUserId, String(form.get('id') ?? ''));
  revalidatePath('/questions');
  redirect('/questions');
}
