import Link from 'next/link';
import { notFound } from 'next/navigation';
import { kpiPath, NotFoundError, type SlackChannel } from '@/core';
import chat from '@/web/chat/chat.module.css';
import { requireUser } from '@/web/current-user';
import { AlertForm } from '@/web/kpis/AlertForm';
import { getCore } from '@/web/server-runtime';

export const metadata = { title: 'Edit KPI Alert · BIBot' };
export const dynamic = 'force-dynamic';

/** Edits a KPI Alert's condition, frequency, destination and name. Anyone may. */
export default async function EditAlertPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const core = await getCore();
  const alert = await core.kpis.getAlert(user.slackUserId, id).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!alert) notFound();
  const channels: SlackChannel[] | null = await core.reports.slackChannels(user.slackUserId).catch(() => null);
  return (
    <div className={chat.page}>
      <header className={chat.conversationHeader}>
        <h1>Edit {alert.name}</h1>
        <Link href={kpiPath(alert.kpiId)} className="btn btn--ghost">
          Back to the KPI
        </Link>
      </header>
      <section className="card">
        <AlertForm
          channels={channels}
          alert={{
            id: alert.id,
            name: alert.name,
            condition: alert.condition,
            schedule: alert.schedule,
            timezone: alert.timezone,
            destination: alert.destination,
            dmRecipient: alert.createdBy === user.slackUserId ? 'You' : alert.createdByName,
          }}
        />
      </section>
    </div>
  );
}
