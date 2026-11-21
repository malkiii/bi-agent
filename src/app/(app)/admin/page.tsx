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
        <li>
          <Link href="/catalog">Catalog</Link>: Dataset and column descriptions and Synonyms (Edit on each Dataset).
        </li>
        <li>
          <Link href="/admin/users">Users &amp; roles</Link>
        </li>
        <li>
          <Link href="/admin/settings">Settings</Link>: the LLM provider and model.
        </li>
      </ul>
      <p>The audit log will live here too.</p>
    </section>
  );
}
