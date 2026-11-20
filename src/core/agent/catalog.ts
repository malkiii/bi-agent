import type { CatalogDataset, DataSources } from '../data-sources/data-sources';
import type { Dialect, DriverQuery, QueryResult } from '../data-sources/driver';

/** A Data Source as the agent sees it: only its Exposed Datasets, plus its dialect. */
export interface AgentDataSource {
  dataSourceId: string;
  name: string;
  kind: string;
  dialect: Dialect;
  datasets: CatalogDataset[];
}

/**
 * What the agent may query during one Answer. Data Sources without Exposed Datasets don't
 * exist for it. This is the one place that narrows the choice of Data Sources: the
 * Conversation lock (web) and Channel Default (Slack) plug in here via `onlyDataSourceIds`.
 */
export interface AgentCatalog {
  dataSources(): Promise<AgentDataSource[]>;
  dataSource(id: string): Promise<AgentDataSource | undefined>;
  execute(dataSourceId: string, query: DriverQuery): Promise<QueryResult>;
}

export function createAgentCatalog(
  dataSources: DataSources,
  options: { onlyDataSourceIds?: readonly string[] } = {},
): AgentCatalog {
  let loaded: Promise<AgentDataSource[]> | undefined;

  async function load(): Promise<AgentDataSource[]> {
    const all = await dataSources.list();
    const visible = all.filter(
      (ds) =>
        ds.datasets.some((d) => d.exposed) &&
        (!options.onlyDataSourceIds || options.onlyDataSourceIds.includes(ds.id)),
    );
    return Promise.all(
      visible.map(async (ds) => ({
        dataSourceId: ds.id,
        name: ds.name,
        kind: ds.kind,
        dialect: await dataSources.withDriver(ds.id, async (driver) => driver.dialect),
        datasets: ds.datasets.filter((d) => d.exposed),
      })),
    );
  }

  const catalog: AgentCatalog = {
    dataSources: () => (loaded ??= load()),
    async dataSource(id) {
      return (await catalog.dataSources()).find((ds) => ds.dataSourceId === id);
    },
    execute: (dataSourceId, query) => dataSources.withDriver(dataSourceId, (driver) => driver.execute(query)),
  };
  return catalog;
}
