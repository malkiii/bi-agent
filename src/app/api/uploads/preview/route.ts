import { NextResponse } from 'next/server';
import { AppError, MAX_UPLOAD_BYTES } from '@/core';
import { getCurrentUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';

/** POST multipart `file`: parses and stages a CSV/XLSX upload and returns its preview. */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Sign in to upload files.' }, { status: 401 });

  // Refuse obviously oversized bodies before reading them (the App Core checks the file itself).
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_UPLOAD_BYTES + 1024 * 1024) {
    const mb = (length / (1024 * 1024)).toFixed(1);
    return NextResponse.json({ error: `Files can be at most 50 MB; this one is ${mb} MB.` }, { status: 413 });
  }

  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get('file');
  } catch {
    return NextResponse.json({ error: 'The upload could not be read. Try again.' }, { status: 400 });
  }
  if (!(file instanceof File)) return NextResponse.json({ error: 'Choose a CSV or XLSX file.' }, { status: 400 });

  try {
    const preview = await (await getCore()).uploads.preview(user.slackUserId, {
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return NextResponse.json(preview);
  } catch (error) {
    if (error instanceof AppError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
