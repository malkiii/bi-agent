import { notFound } from 'next/navigation';
import { builtInDrivers } from '@/drivers';
import { DataSourceForm } from '@/web/components/DataSourceForm';
import { saveDataSource, testDataSource } from '../actions';

export default async function NewDataSourcePage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const { kind = 'postgres' } = await searchParams;
  const driverKind = Object.hasOwn(builtInDrivers, kind) ? builtInDrivers[kind] : undefined;
  if (!driverKind) notFound();
  return (
    <section className="card">
      <h1>Add a {driverKind.label} Data Source</h1>
      <DataSourceForm
        kind={{ kind: driverKind.kind, label: driverKind.label, fields: driverKind.fields }}
        saveAction={saveDataSource}
        testAction={testDataSource}
      />
    </section>
  );
}
