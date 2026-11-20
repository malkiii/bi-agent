'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { AppError, ValidationError, type ConnectionTestResult, type DataSourceInput } from '@/core';
import { builtInDrivers } from '@/drivers';
import { requireUser } from '@/web/current-user';
import { oauthCallbackUrl } from '@/web/oauth';
import { getCore } from '@/web/server-runtime';

/** Data Source admin actions. /admin is admin-only in the proxy, and the App Core checks again. */

export interface DataSourceFormState {
  message?: string;
  fieldErrors?: Record<string, string>;
  test?: ConnectionTestResult;
}

const BASE = '/admin/data-sources';

function readInput(formData: FormData): DataSourceInput {
  const kind = String(formData.get('kind') ?? '');
  const fields = Object.hasOwn(builtInDrivers, kind) ? builtInDrivers[kind]!.fields : [];
  const config: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  for (const field of fields) {
    const value = String(formData.get(field.key) ?? '');
    if (field.secret) secrets[field.key] = value;
    else config[field.key] = value;
  }
  return { name: String(formData.get('name') ?? ''), kind, config, secrets };
}

function toState(error: unknown): DataSourceFormState {
  if (error instanceof ValidationError) return { message: error.message, fieldErrors: { ...error.fieldErrors } };
  if (error instanceof AppError) return { message: error.message };
  throw error;
}

export async function saveDataSource(_prev: DataSourceFormState, formData: FormData): Promise<DataSourceFormState> {
  const user = await requireUser();
  const dataSources = (await getCore()).dataSources;
  const id = formData.get('id');
  let savedId: string;
  try {
    const input = readInput(formData);
    const saved = id
      ? await dataSources.update(user.slackUserId, String(id), input)
      : await dataSources.create(user.slackUserId, input);
    savedId = saved.id;
  } catch (error) {
    return toState(error);
  }
  revalidatePath(BASE);
  redirect(`${BASE}/${savedId}?notice=saved`);
}

export async function testDataSource(_prev: DataSourceFormState, formData: FormData): Promise<DataSourceFormState> {
  const user = await requireUser();
  const id = formData.get('id');
  try {
    const test = await (await getCore()).dataSources.testConnection(user.slackUserId, {
      ...readInput(formData),
      id: id ? String(id) : undefined,
    });
    return { test };
  } catch (error) {
    return toState(error);
  }
}

/** For the plain forms on the detail page: report the outcome through the URL. */
async function runAndReturn(id: string, notice: string, work: () => Promise<unknown>): Promise<never> {
  let query: string;
  try {
    await work();
    query = `notice=${notice}`;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    query = `error=${encodeURIComponent(error.message)}`;
  }
  revalidatePath(BASE);
  redirect(`${BASE}/${id}?${query}`);
}

export async function refreshDataSourceSchema(formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get('id'));
  const core = await getCore();
  await runAndReturn(id, 'refreshed', () => core.dataSources.refreshSchema(user.slackUserId, id));
}

export async function saveExposedDatasets(formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get('id'));
  const datasetIds = formData.getAll('dataset').map(String);
  const core = await getCore();
  await runAndReturn(id, 'exposed', () => core.dataSources.setExposedDatasets(user.slackUserId, id, datasetIds));
}

export async function deleteDataSource(formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get('id'));
  try {
    await (await getCore()).dataSources.delete(user.slackUserId, id);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    redirect(`${BASE}/${id}?error=${encodeURIComponent(error.message)}`);
  }
  revalidatePath(BASE);
  redirect(BASE);
}

/** OAuth kinds (Salesforce): send the admin to the provider's consent screen. */
export async function connectDataSource(formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get('id'));
  let url: string;
  try {
    ({ url } = await (await getCore()).dataSources.startOAuth(user.slackUserId, id, {
      redirectUri: await oauthCallbackUrl(),
    }));
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    redirect(`${BASE}/${id}?error=${encodeURIComponent(error.message)}`);
  }
  redirect(url);
}
