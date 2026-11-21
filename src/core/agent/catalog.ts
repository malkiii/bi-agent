import { hasExposedDatasets, type CatalogDataset, type DataSources } from '../data-sources/data-sources';
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
 * Conversation lock (web) plugs in as `onlyDataSourceIds`, the Channel Default (Slack) as
 * `preferredDataSourceIds`.
 */
export interface AgentCatalog {
  dataSources(): Promise<AgentDataSource[]>;
  dataSource(id: string): Promise<AgentDataSource | undefined>;
  execute(dataSourceId: string, query: DriverQuery): Promise<QueryResult>;
}

export function createAgentCatalog(
  dataSources: DataSources,
  options: {
    /** Only these Data Sources, even when none of them can be queried. */
    onlyDataSourceIds?: readonly string[];
    /** Only these Data Sources while at least one of them can be queried; otherwise all of them. */
    preferredDataSourceIds?: readonly string[];
  } = {},
): AgentCatalog {
  let loaded: Promise<AgentDataSource[]> | undefined;

  async function load(): Promise<AgentDataSource[]> {
    const queryable = (await dataSources.list()).filter(hasExposedDatasets);
    const among = (ids: readonly string[]) => queryable.filter((ds) => ids.includes(ds.id));
    const preferred = options.preferredDataSourceIds ? among(options.preferredDataSourceIds) : [];
    const visible = options.onlyDataSourceIds
      ? among(options.onlyDataSourceIds)
      : preferred.length > 0
        ? preferred
        : queryable;
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
