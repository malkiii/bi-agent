'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { AppError, kpiPath, ValidationError, type KpiAlertCondition, type KpiAlertInput, type ReportSchedule } from '@/core';
import { HOURLY_CRON } from '@/core/kpis/kpi-options';
import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';

/** Thin adapters over `core.kpis`; the App Core validates. */

export interface KpiFormState {
  message?: string;
  fieldErrors?: Record<string, string>;
}

/** The agent drafts the KPI's query from the Prompt, then the KPI opens to be checked and approved. */
export async function createKpiAction(_prev: KpiFormState, form: FormData): Promise<KpiFormState> {
  const user = await requireUser();
  let id: string;
  try {
    const kpi = await (await getCore()).kpis.createFromPrompt(user.slackUserId, { prompt: text(form, 'prompt'), name: text(form, 'name') });
    id = kpi.id;
  } catch (error) {
    return failure(error);
  }
  revalidatePath('/kpis');
  redirect(kpiPath(id));
}

export interface ApproveKpiState {
  error?: string;
}

/** Pins the draft's query once it gives a single number. */
export async function approveKpiAction(_prev: ApproveKpiState, form: FormData): Promise<ApproveKpiState> {
  const user = await requireUser();
  const id = text(form, 'id');
  try {
    await (await getCore()).kpis.approve(user.slackUserId, id);
  } catch (error) {
    if (error instanceof AppError) return { error: error.message };
    throw error;
  }
  revalidatePath('/kpis');
  revalidatePath(kpiPath(id));
  return {};
}

/** Renames a KPI. */
export async function renameKpiAction(_prev: KpiFormState, form: FormData): Promise<KpiFormState> {
  const user = await requireUser();
  const id = text(form, 'id');
  try {
    await (await getCore()).kpis.rename(user.slackUserId, id, text(form, 'name'));
  } catch (error) {
    return failure(error);
  }
  revalidatePath('/kpis');
  revalidatePath(kpiPath(id));
  return {};
}

/** Runs the KPI's Pinned Query now to show its current value. */
export async function refreshKpiAction(_prev: ApproveKpiState, form: FormData): Promise<ApproveKpiState> {
  const user = await requireUser();
  const id = text(form, 'id');
  try {
    await (await getCore()).kpis.refresh(user.slackUserId, id);
  } catch (error) {
    if (error instanceof AppError) return { error: error.message };
    throw error;
  }
  revalidatePath('/kpis');
  revalidatePath(kpiPath(id));
  return {};
}

/** Pauses an active KPI or resumes a paused one (`change` is `pause` or `resume`). */
export async function pauseOrResumeKpiAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const id = text(form, 'id');
  const kpis = (await getCore()).kpis;
  await (text(form, 'change') === 'resume' ? kpis.resume(user.slackUserId, id) : kpis.pause(user.slackUserId, id));
  revalidatePath('/kpis');
  revalidatePath(kpiPath(id));
}

/** Admin only: deletes a KPI and its Alerts. */
export async function deleteKpiAction(form: FormData): Promise<void> {
  const user = await requireUser();
  await (await getCore()).kpis.remove(user.slackUserId, text(form, 'id'));
  revalidatePath('/kpis');
  redirect('/kpis');
}

/** Adds an Alert to the KPI `kpiId`. */
export async function createAlertAction(_prev: KpiFormState, form: FormData): Promise<KpiFormState> {
  const user = await requireUser();
  const kpiId = text(form, 'kpiId');
  try {
    await (await getCore()).kpis.createAlert(user.slackUserId, { kpiId, ...alertInputFrom(form) });
  } catch (error) {
    return failure(error);
  }
  revalidatePath(kpiPath(kpiId));
  redirect(kpiPath(kpiId));
}

/** Changes an Alert's name, condition, frequency and destination. */
export async function updateAlertAction(_prev: KpiFormState, form: FormData): Promise<KpiFormState> {
  const user = await requireUser();
  let kpiId: string;
  try {
    const alert = await (await getCore()).kpis.updateAlert(user.slackUserId, text(form, 'id'), alertInputFrom(form));
    kpiId = alert.kpiId;
  } catch (error) {
    return failure(error);
  }
  revalidatePath(kpiPath(kpiId));
  redirect(kpiPath(kpiId));
}

/** Pauses an active Alert or resumes a paused one (`change` is `pause` or `resume`). */
export async function pauseOrResumeAlertAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const id = text(form, 'id');
  const kpis = (await getCore()).kpis;
  const alert = await (text(form, 'change') === 'resume' ? kpis.resumeAlert(user.slackUserId, id) : kpis.pauseAlert(user.slackUserId, id));
  revalidatePath(kpiPath(alert.kpiId));
}

/** Admin only: deletes an Alert. */
export async function deleteAlertAction(form: FormData): Promise<void> {
  const user = await requireUser();
  await (await getCore()).kpis.removeAlert(user.slackUserId, text(form, 'id'));
  revalidatePath(kpiPath(text(form, 'kpiId')));
}

function failure(error: unknown): KpiFormState {
  if (error instanceof ValidationError) return { message: error.message, fieldErrors: { ...error.fieldErrors } };
  if (error instanceof AppError) return { message: error.message };
  throw error;
}

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

/** An empty field is NaN, which the App Core refuses with a field error. */
function number(form: FormData, key: string): number {
  const value = text(form, key).trim();
  return value === '' ? NaN : Number(value);
}

function alertInputFrom(form: FormData): KpiAlertInput {
  return {
    name: text(form, 'name'),
    condition: conditionFrom(form),
    schedule: frequencyFrom(form),
    timezone: text(form, 'timezone'),
    destination: form.get('destinationKind') === 'dm' ? { kind: 'dm' } : { kind: 'channel', channel: text(form, 'channel') },
  };
}

function conditionFrom(form: FormData): KpiAlertCondition {
  const kind = text(form, 'conditionKind');
  if (kind === 'change') {
    const direction = text(form, 'direction');
    return { kind: 'change', direction: direction === 'down' || direction === 'either' ? direction : 'up', percent: number(form, 'percent') };
  }
  return { kind: kind === 'below' ? 'below' : 'above', value: number(form, 'value') };
}

/** `hourly` is the cron expression "0 * * * *". */
function frequencyFrom(form: FormData): ReportSchedule {
  const time = text(form, 'time');
  switch (text(form, 'frequency')) {
    case 'hourly':
      return { kind: 'cron', expression: HOURLY_CRON };
    case 'weekly':
      return { kind: 'weekly', weekday: Number(text(form, 'weekday')), time };
    case 'cron':
      return { kind: 'cron', expression: text(form, 'cron') };
    default:
      return { kind: 'daily', time };
  }
}
