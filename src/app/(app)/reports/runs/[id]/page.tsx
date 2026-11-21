import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError, reportPath } from '@/core';
import { BlockView } from '@/web/chat/AnswerView';
import chat from '@/web/chat/chat.module.css';
import { Markdown } from '@/web/chat/Markdown';
import { requireUser } from '@/web/current-user';
import { formatInZone } from '@/web/reports/format';
import styles from '@/web/reports/reports.module.css';
import { PrintButton } from '@/web/reports/PrintButton';
import { getCore } from '@/web/server-runtime';

export const metadata = { title: 'Report Run · Botley' };
export const dynamic = 'force-dynamic';

/**
 * A Report Run: frozen tables, charts and commentary from when it was generated. Any signed-in
 * user may open it, also after its Report was deleted. Prints to A4 (see the print CSS).
 */
export default async function ReportRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const reports = (await getCore()).reports;
  const run = await reports.getRun(user.slackUserId, id).catch(orNull);
  if (!run) notFound();
  const reportExists = (await reports.get(user.slackUserId, run.reportId).catch(orNull)) !== null;

  return (
    <article className={`${chat.page} ${styles.run}`}>
      <header className={chat.conversationHeader}>
        <h1>{run.title}</h1>
        <div className="actions no-print">
          <PrintButton />
          {reportExists && (
            <Link href={reportPath(run.reportId)} className="btn btn--ghost">
              Report
            </Link>
          )}
        </div>
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

function orNull(error: unknown): null {
  if (error instanceof NotFoundError) return null;
  throw error;
}
