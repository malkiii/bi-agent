import { NextResponse } from 'next/server';
import { AppError, ValidationError, type UploadChoice } from '@/core';
import { getCurrentUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';

/** POST `{ previewId, choices }`: saves the chosen sheets of a preview as Datasets. */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Sign in to upload files.' }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { previewId?: unknown; choices?: unknown } | null;
  if (!body || typeof body.previewId !== 'string' || !Array.isArray(body.choices)) {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 });
  }

  try {
    const datasets = await (await getCore()).uploads.confirm(
      user.slackUserId,
      body.previewId,
      body.choices as UploadChoice[],
    );
    return NextResponse.json({ datasets });
  } catch (error) {
    if (error instanceof ValidationError) {
      return NextResponse.json({ error: error.message, fieldErrors: error.fieldErrors }, { status: 400 });
    }
    if (error instanceof AppError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
