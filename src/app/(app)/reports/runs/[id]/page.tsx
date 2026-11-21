import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError } from '@/core';
import { BlockView } from '@/web/chat/AnswerView';
import chat from '@/web/chat/chat.module.css';
import { Markdown } from '@/web/chat/Markdown';
import { requireUser } from '@/web/current-user';
import { formatInZone } from '@/web/reports/format';
import styles from '@/web/reports/reports.module.css';
import { getCore } from '@/web/server-runtime';

export const metadata = { title: 'Report Run · Botley' };
export const dynamic = 'force-dynamic';

/** A Report Run: frozen tables, charts and commentary from when it was generated. Any signed-in user may open it. */
export default async function ReportRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const run = await (await getCore()).reports.getRun(user.slackUserId, id).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!run) notFound();

  return (
    <article className={chat.page}>
      <header className={chat.conversationHeader}>
        <h1>{run.title}</h1>
        <Link href={`/reports/${run.reportId}`} className="btn btn--ghost">
          Report
        </Link>
      </header>
      <p className={chat.muted}>
        Generated {formatInZone(run.finishedAt, run.timezone)} ({run.timezone}). The data is as of then.
      </p>
      {run.status === 'failed' && (
        <p className={styles.error} role="alert">
          This Report Run could not be completed: {run.error}
        </p>
      )}
      {run.commentary && (
        <section className={styles.commentary}>
          <Markdown text={run.commentary} />
        </section>
      )}
      <section className={`card ${chat.answer}`}>
        {run.blocks.map((b, i) =>
          b.status === 'ok' ? (
            <BlockView key={i} block={b.block} />
          ) : (
            <p key={i} className={styles.error} role="alert">
              {b.error}
            </p>
          ),
        )}
        {run.sources.length > 0 && (
          <p className={chat.muted}>
            Sources: {run.sources.map((s) => `${s.name}${s.datasets.length ? ` (${s.datasets.join(', ')})` : ''}`).join('; ')}
          </p>
        )}
      </section>
    </article>
  );
}
