'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { AppError, NotFoundError, reportPath, ValidationError, type ReportDestinationInput, type ReportSchedule } from '@/core';
import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';

/** Thin adapters over `core.reports`; the App Core validates and checks the destination channel. */

export interface ReportFormState {
  message?: string;
  fieldErrors?: Record<string, string>;
}

/** Creates a draft Report from a Prompt (the agent answers first) or a Saved Question, then opens it. */
export async function createReportAction(_prev: ReportFormState, form: FormData): Promise<ReportFormState> {
  const user = await requireUser();
  const core = await getCore();
  const settings = {
    title: text(form, 'title'),
    schedule: scheduleFrom(form),
    timezone: text(form, 'timezone'),
    destination: destinationFrom(form),
  };
  let id: string;
  try {
    const report =
      form.get('queriesFrom') === 'savedQuestion'
        ? await core.reports.createFromSavedQuestion(user.slackUserId, { ...settings, savedQuestionId: text(form, 'savedQuestionId') })
        : await core.reports.createFromPrompt(user.slackUserId, { ...settings, prompt: text(form, 'prompt') });
    id = report.id;
  } catch (error) {
    if (error instanceof ValidationError) return { message: error.message, fieldErrors: { ...error.fieldErrors } };
    if (error instanceof AppError) return { message: error.message };
    throw error;
  }
  revalidatePath('/reports');
  redirect(reportPath(id));
}

export interface ApproveState {
  error?: string;
}

/** Pins the draft's queries and starts the schedule. */
export async function approveReportAction(_prev: ApproveState, form: FormData): Promise<ApproveState> {
  const user = await requireUser();
  const id = text(form, 'id');
  try {
    await (await getCore()).reports.approve(user.slackUserId, id);
  } catch (error) {
    if (error instanceof AppError) return { error: error.message };
    throw error;
  }
  revalidatePath('/reports');
  revalidatePath(reportPath(id));
  return {};
}

/** Changes a Report's title, schedule, timezone and destination. */
export async function updateReportAction(_prev: ReportFormState, form: FormData): Promise<ReportFormState> {
  const user = await requireUser();
  const id = text(form, 'id');
  try {
    await (
      await getCore()
    ).reports.update(user.slackUserId, id, {
      title: text(form, 'title'),
      schedule: scheduleFrom(form),
      timezone: text(form, 'timezone'),
      destination: destinationFrom(form),
    });
  } catch (error) {
    if (error instanceof ValidationError) return { message: error.message, fieldErrors: { ...error.fieldErrors } };
    if (error instanceof AppError) return { message: error.message };
    throw error;
  }
  revalidatePath('/reports');
  redirect(reportPath(id));
}

/** Pauses an active Report or resumes a paused one (`change` is `pause` or `resume`). */
export async function pauseOrResumeReportAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const id = text(form, 'id');
  const reports = (await getCore()).reports;
  await (text(form, 'change') === 'resume' ? reports.resume(user.slackUserId, id) : reports.pause(user.slackUserId, id));
  revalidatePath('/reports');
  revalidatePath(reportPath(id));
}

/** Admin only: deletes a Report; its Report Runs stay. */
export async function deleteReportAction(form: FormData): Promise<void> {
  const user = await requireUser();
  await (await getCore()).reports.remove(user.slackUserId, text(form, 'id'));
  revalidatePath('/reports');
  redirect('/reports');
}

/** Admin only: deletes one Report Run, then returns to its Report (or the Reports list once the Report is gone). */
export async function deleteReportRunAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const reportId = text(form, 'reportId');
  try {
    await (await getCore()).reports.removeRun(user.slackUserId, text(form, 'id'));
  } catch (error) {
    // Already deleted, e.g. in another tab.
    if (!(error instanceof NotFoundError)) throw error;
  }
  revalidatePath(reportPath(reportId));
  redirect(text(form, 'back') === 'report' ? reportPath(reportId) : '/reports');
}

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

function scheduleFrom(form: FormData): ReportSchedule {
  const time = text(form, 'time');
  switch (text(form, 'scheduleKind')) {
    case 'weekly':
      return { kind: 'weekly', weekday: Number(text(form, 'weekday')), time };
    case 'monthly':
      return { kind: 'monthly', day: Number(text(form, 'day')), time };
    case 'cron':
      return { kind: 'cron', expression: text(form, 'cron') };
    default:
      return { kind: 'daily', time };
  }
}

function destinationFrom(form: FormData): ReportDestinationInput {
  return form.get('destinationKind') === 'dm' ? { kind: 'dm' } : { kind: 'channel', channel: text(form, 'channel') };
}
