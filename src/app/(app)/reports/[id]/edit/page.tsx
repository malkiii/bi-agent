import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError, type SlackChannel } from '@/core';
import chat from '@/web/chat/chat.module.css';
import { requireUser } from '@/web/current-user';
import { ReportForm } from '@/web/reports/ReportForm';
import { getCore } from '@/web/server-runtime';

export const metadata = { title: 'Edit Report · BIBot' };
export const dynamic = 'force-dynamic';

/** Edit a Report's title, schedule, timezone and destination. Anyone may, as Reports have no owner. */
export default async function EditReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const core = await getCore();
  const report = await core.reports.get(user.slackUserId, id).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!report) notFound();
  const channels: SlackChannel[] | null = await core.reports.slackChannels(user.slackUserId).catch(() => null);
  return (
    <div className={chat.page}>
      <header className={chat.conversationHeader}>
        <h1>Edit {report.title}</h1>
        <Link href={`/reports/${report.id}`} className="btn btn--ghost">
          Back to the Report
        </Link>
      </header>
      <section className="card">
        <ReportForm
          channels={channels}
          report={{
            id: report.id,
            title: report.title,
            schedule: report.schedule,
            timezone: report.timezone,
            destination: report.destination,
            dmRecipient: report.createdBy === user.slackUserId ? 'Me' : report.createdByName,
          }}
        />
      </section>
    </div>
  );
}
