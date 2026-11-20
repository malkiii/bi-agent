import { Botley } from '@/web/components/Botley';

/** Admin area. Access is enforced in src/proxy.ts (routeAccess: everything under /admin). */
export default function AdminPage() {
  return (
    <section className="card">
      <Botley rest="empty" size={96} />
      <h1>Admin</h1>
      <p>Data Sources, Datasets, Synonyms, roles and the audit log will live here.</p>
    </section>
  );
}
