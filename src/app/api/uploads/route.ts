import { auth } from '@/auth';
import { AppError, MAX_UPLOAD_BYTES } from '@/core';
import { getCore } from '@/web/server-runtime';

export const dynamic = 'force-dynamic';

/** Room for the multipart envelope around a file at the limit. */
const MULTIPART_OVERHEAD = 1024 * 1024;

const TOO_LARGE = 'This file is larger than 50 MB; uploads can be at most 50 MB.';

/**
 * Step 1 of an upload: the browser posts the file (multipart field `file`) and gets the preview
 * (inferred column types, first rows) back. A route handler rather than a server action, so a
 * 50 MB body is accepted (see `proxyClientMaxBodySize` in next.config.ts).
 */
export async function POST(req: Request) {
  const session = await auth();
  const slackUserId = session?.user?.slackUserId;
  if (!slackUserId) return Response.json({ error: 'unauthorized' }, { status: 401 });

  // Refuse before reading the body: the proxy only buffers up to the configured limit.
  if (Number(req.headers.get('content-length') ?? 0) > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD) {
    return Response.json({ error: TOO_LARGE }, { status: 413 });
  }
  let file: FormDataEntryValue | null;
  try {
    file = (await req.formData()).get('file');
  } catch {
    return Response.json({ error: 'The upload could not be read. Try again.' }, { status: 400 });
  }
  if (!(file instanceof File)) return Response.json({ error: 'Choose a CSV, XLSX or SQLite file.' }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return Response.json({ error: TOO_LARGE }, { status: 413 });

  try {
    const preview = await (await getCore()).uploads.preview(slackUserId, {
      filename: file.name,
      content: new Uint8Array(await file.arrayBuffer()),
    });
    return Response.json(preview);
  } catch (error) {
    if (error instanceof AppError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
