import Link from 'next/link';
import { Botley } from '@/web/components/Botley';

/** Shown (with HTTP 403) when a member requests an admin-only page. */
export default function ForbiddenPage() {
  return (
    <section className="card">
      <Botley rest="error" size={96} />
      <h1>Admins only</h1>
      <p>This page is for admins. Ask an admin if you need access.</p>
      <Link href="/" className="btn">
        Back home
      </Link>
    </section>
  );
}
