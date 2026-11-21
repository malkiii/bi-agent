import { hasExposedDatasets, type SlackChannel } from '@/core';
import { PendingButton } from '@/web/components/PendingButton';
import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';
import { removeChannelDefaultAction } from './actions';
import { ChannelDefaultForm } from './ChannelDefaultForm';
import styles from './channels.module.css';

export const dynamic = 'force-dynamic';

/** Admin: Channel Defaults. Access: src/proxy.ts plus `channelDefaults` in the App Core. */
export default async function ChannelDefaultsPage() {
  const me = await requireUser();
  const core = await getCore();
  const [defaults, sources] = await Promise.all([core.channelDefaults.list(me.slackUserId), core.dataSources.list()]);
  const channels: SlackChannel[] | null = await core.channelDefaults.slackChannels(me.slackUserId).catch(() => null);
  const names = new Map(sources.map((ds) => [ds.id, ds.name]));

  return (
    <section className="card">
      <h1>Channel Defaults</h1>
      <p className={styles.muted}>
        Choose the Data Sources Botley uses for Prompts in a Slack channel, so Prompts in #finance go to the finance
        database. Channels without one, and DMs, can use every Data Source.
      </p>

      {defaults.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Channel</th>
                <th>Data Sources</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {defaults.map((d) => (
                <tr key={d.channel}>
                  <td>{d.channelName === d.channel ? d.channel : `#${d.channelName}`}</td>
                  <td>{d.dataSourceIds.map((id) => names.get(id) ?? '(deleted Data Source)').join(', ')}</td>
                  <td>
                    <form action={removeChannelDefaultAction}>
                      <input type="hidden" name="channel" value={d.channel} />
                      <PendingButton className="btn btn--ghost">Remove</PendingButton>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Add or change</h2>
      <ChannelDefaultForm
        channels={channels}
        dataSources={sources.map((ds) => ({ id: ds.id, name: ds.name, queryable: hasExposedDatasets(ds) }))}
        existing={Object.fromEntries(defaults.map((d) => [d.channel, d.dataSourceIds]))}
      />
    </section>
  );
}
