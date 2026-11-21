import Link from 'next/link';
import { BIBot } from '@/web/components/BIBot';

export default function NotFound() {
  return (
    <main className="page-narrow">
      <section className="card">
        <BIBot rest="empty" size={120} />
        <h1>Nothing here</h1>
        <p>BIBot looked everywhere, but this page doesn&apos;t exist.</p>
        <Link href="/" className="btn">
          Back home
        </Link>
      </section>
    </main>
  );
}
