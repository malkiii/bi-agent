import { notFound } from 'next/navigation';
import { builtInDrivers } from '@/drivers';
import { CONNECTION_URL_KINDS } from '@/core/data-sources/connection-url';
import { NewDataSource } from '@/web/components/NewDataSource';
import { saveDataSource, testDataSource } from '../actions';

/** What the browser needs of a kind to render its form. */
const formKind = ({ kind, label, fields }: (typeof builtInDrivers)[string]) => ({ kind, label, fields });

export default async function NewDataSourcePage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const { kind = 'postgres' } = await searchParams;
  const driverKind = Object.hasOwn(builtInDrivers, kind) ? builtInDrivers[kind] : undefined;
  if (!driverKind) notFound();
  const urlKinds = CONNECTION_URL_KINDS.flatMap((k) => (Object.hasOwn(builtInDrivers, k) ? [formKind(builtInDrivers[k]!)] : []));
  return (
    <section className="card">
      <h1>Add a Data Source</h1>
      <NewDataSource kinds={urlKinds} initialKind={formKind(driverKind)} saveAction={saveDataSource} testAction={testDataSource} />
    </section>
  );
}
