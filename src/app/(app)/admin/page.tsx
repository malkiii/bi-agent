import Link from 'next/link';

/** Admin area. Access is enforced in src/proxy.ts (routeAccess: everything under /admin). */
export default function AdminPage() {
  return (
    <section className="card">
      <h1>Admin</h1>
      <ul>
        <li>
          <Link href="/admin/data-sources">Data Sources</Link>: connections, credentials and Exposed Datasets.
        </li>
      </ul>
      <p>Synonyms, roles and the audit log will live here too.</p>
    </section>
  );
}
