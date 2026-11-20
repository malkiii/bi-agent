'use server';

import { revalidatePath } from 'next/cache';
import { AppError } from '@/core';
import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';

export interface SetRoleState {
  error: string | null;
}

/**
 * Promotes or demotes a user. src/proxy.ts already refuses members on /admin, and the
 * App Core checks again (`users.setRole` requires an admin), so this stays a thin adapter.
 */
export async function setRoleAction(_prev: SetRoleState, form: FormData): Promise<SetRoleState> {
  const actor = await requireUser();
  const target = form.get('slackUserId');
  const role = form.get('role');
  if (typeof target !== 'string' || (role !== 'admin' && role !== 'member')) return { error: 'Invalid request.' };
  try {
    await (await getCore()).users.setRole(actor.slackUserId, target, role);
  } catch (error) {
    if (error instanceof AppError) return { error: error.message };
    throw error;
  }
  revalidatePath('/admin/users');
  return { error: null };
}
