import Link from 'next/link';
import type { SlackChannel } from '@/core';
import chat from '@/web/chat/chat.module.css';
import { requireUser } from '@/web/current-user';
import { ReportForm } from '@/web/reports/ReportForm';
import { getCore } from '@/web/server-runtime';

export const metadata = { title: 'New Report · BIBot' };
export const dynamic = 'force-dynamic';

/** New Report from a Prompt. */
export default async function NewReportPage() {
  const user = await requireUser();
  const core = await getCore();
  const channels: SlackChannel[] | null = await core.reports.slackChannels(user.slackUserId).catch(() => null);
  return (
    <div className={chat.page}>
      <header className={chat.conversationHeader}>
        <h1>New Report</h1>
        <Link href="/reports" className="btn btn--ghost">
          All Reports
        </Link>
      </header>
      <section className="card">
        <ReportForm channels={channels} />
      </section>
    </div>
  );
}
