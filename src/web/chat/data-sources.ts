import { hasExposedDatasets, type AppCore } from '@/core';
import type { DataSourceOption } from './DataSourcePicker';

/**
 * The web chat's Data Source picker options: Data Sources the agent can query (with Exposed
 * Datasets), plus any the Conversation is locked to, so a lock can always be undone.
 */
export async function chatDataSources(core: AppCore, lockedDataSourceIds: readonly string[] = []): Promise<DataSourceOption[]> {
  const all = await core.dataSources.list();
  return all
    .filter((ds) => hasExposedDatasets(ds) || lockedDataSourceIds.includes(ds.id))
    .map((ds) => ({ id: ds.id, name: ds.name }));
}
