import { auth } from '@/auth';
import { NotFoundError, TABLE_FILE_TYPES, tableFileName, tableToCsv, tableToXlsx, type TableFileFormat } from '@/core';
import { getCore } from '@/web/server-runtime';

export const dynamic = 'force-dynamic';

/**
 * Download one Table Result Block of a stored Answer as CSV or XLSX (`?format=csv|xlsx`), with
 * every row the block holds. Only Participants of the Answer's Conversation get it; others get 404.
 */
export async function GET(req: Request, { params }: { params: Promise<{ messageId: string; index: string }> }) {
  const session = await auth();
  const slackUserId = session?.user?.slackUserId;
  if (!slackUserId) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const { messageId, index } = await params;
  const format = new URL(req.url).searchParams.get('format') as TableFileFormat | null;
  if (format !== 'csv' && format !== 'xlsx') return Response.json({ error: 'format must be csv or xlsx' }, { status: 400 });

  let answer;
  try {
    answer = await (await getCore()).conversations.getVisibleAnswer(slackUserId, messageId);
  } catch (error) {
    if (error instanceof NotFoundError) return Response.json({ error: error.message }, { status: 404 });
    throw error;
  }
  const block = answer.blocks[Number(index)];
  if (!/^\d+$/.test(index) || block?.type !== 'table') return Response.json({ error: 'Table not found.' }, { status: 404 });

  const body = format === 'csv' ? tableToCsv(block) : await tableToXlsx(block);
  const filename = tableFileName(block, format);
  return new Response(body as BodyInit, {
    headers: {
      'content-type': TABLE_FILE_TYPES[format],
      'content-disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'cache-control': 'private, no-store',
    },
  });
}
