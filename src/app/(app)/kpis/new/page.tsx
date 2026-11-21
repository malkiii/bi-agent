import Link from 'next/link';
import chat from '@/web/chat/chat.module.css';
import { requireUser } from '@/web/current-user';
import { KpiForm } from '@/web/kpis/KpiForm';

export const metadata = { title: 'New KPI · Botley' };
export const dynamic = 'force-dynamic';

export default async function NewKpiPage() {
  await requireUser();
  return (
    <div className={chat.page}>
      <header className={chat.conversationHeader}>
        <h1>New KPI</h1>
        <Link href="/kpis" className="btn btn--ghost">
          All KPIs
        </Link>
      </header>
      <section className="card">
        <KpiForm />
      </section>
    </div>
  );
}
