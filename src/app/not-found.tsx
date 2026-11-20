import Link from 'next/link';
import { Botley } from '@/web/components/Botley';

export default function NotFound() {
  return (
    <main className="page-narrow">
      <section className="card">
        <Botley rest="empty" size={120} />
        <h1>Nothing here</h1>
        <p>Botley looked everywhere, but this page doesn&apos;t exist.</p>
        <Link href="/" className="btn">
          Back home
        </Link>
      </section>
    </main>
  );
}
