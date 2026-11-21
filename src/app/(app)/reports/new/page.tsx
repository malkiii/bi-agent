import Link from 'next/link';
import type { SlackChannel } from '@/core';
import chat from '@/web/chat/chat.module.css';
import { requireUser } from '@/web/current-user';
import { ReportForm } from '@/web/reports/ReportForm';
import { getCore } from '@/web/server-runtime';

export const metadata = { title: 'New Report · Botley' };
export const dynamic = 'force-dynamic';

/** New Report, optionally from a Saved Question (`?savedQuestion=<id>`). */
export default async function NewReportPage({ searchParams }: { searchParams: Promise<{ savedQuestion?: string }> }) {
  const { savedQuestion } = await searchParams;
  const user = await requireUser();
  const core = await getCore();
  const [mine, shared] = await Promise.all([
    core.savedQuestions.list(user.slackUserId, { scope: 'mine' }),
    core.savedQuestions.list(user.slackUserId, { scope: 'shared' }),
  ]);
  const questions = [...mine, ...shared.filter((q) => !mine.some((m) => m.id === q.id))];
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
        <ReportForm
          savedQuestions={questions.map((q) => ({ id: q.id, title: q.title }))}
          channels={channels}
          initialSavedQuestionId={questions.some((q) => q.id === savedQuestion) ? savedQuestion : undefined}
        />
      </section>
    </div>
  );
}
