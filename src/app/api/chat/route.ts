import { auth } from '@/auth';
import { AppError, NotFoundError } from '@/core';
import type { ChatRequest, ChatStreamEvent } from '@/web/chat/wire';
import { getCore } from '@/web/server-runtime';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Web chat: asks a Prompt in a Web Conversation (a new one when `conversationId` is omitted)
 * and streams the Answer as NDJSON (see src/web/chat/wire.ts). The Answer is saved even if
 * the browser goes away, so it is not tied to the request's abort signal.
 */
export async function POST(req: Request) {
  const session = await auth();
  const slackUserId = session?.user?.slackUserId;
  if (!slackUserId) return Response.json({ error: 'unauthorized' }, { status: 401 });

  let body: Partial<ChatRequest>;
  try {
    body = (await req.json()) as Partial<ChatRequest>;
  } catch {
    return Response.json({ error: 'Invalid JSON.' }, { status: 400 });
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt.trim()) return Response.json({ error: 'Write a Prompt first.' }, { status: 400 });

  const core = await getCore();
  let conversationId: string;
  try {
    conversationId =
      typeof body.conversationId === 'string' && body.conversationId
        ? (await core.conversations.get(slackUserId, body.conversationId)).conversation.id
        : (await core.conversations.startWeb(slackUserId)).id;
  } catch (error) {
    if (error instanceof NotFoundError) return Response.json({ error: error.message }, { status: 404 });
    throw error;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (event: ChatStreamEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false; // the browser went away; keep answering so the Answer is saved
        }
      };
      send({ type: 'conversation', id: conversationId });
      try {
        const answer = await core.conversations.ask(slackUserId, conversationId, prompt, { onEvent: send });
        send({ type: 'answer', answer });
      } catch (error) {
        if (!(error instanceof AppError)) console.error('Chat request failed:', error);
        send({ type: 'error', message: error instanceof AppError ? error.message : 'Something went wrong.' });
      } finally {
        if (open) controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  });
}
