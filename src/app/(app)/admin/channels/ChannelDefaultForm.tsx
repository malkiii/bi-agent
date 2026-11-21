'use client';

import { useActionState, useState } from 'react';
import type { SlackChannel } from '@/core';
import { saveChannelDefaultAction } from './actions';
import formStyles from '@/web/components/DataSourceForm.module.css';
import styles from './channels.module.css';

export interface DataSourceOption {
  id: string;
  name: string;
  /** False when it has no Exposed Datasets (the agent can't query it yet). */
  queryable: boolean;
}

/**
 * Add or change a Channel Default: pick a channel the bot is in (or type its id when Slack
 * can't list channels), then the Data Sources. Picking a channel that already has one loads it.
 */
export function ChannelDefaultForm({
  channels,
  dataSources,
  existing,
}: {
  /** Null when the channel list could not be loaded. */
  channels: SlackChannel[] | null;
  dataSources: DataSourceOption[];
  /** Current Channel Defaults by channel id. */
  existing: Record<string, string[]>;
}) {
  const [state, save, saving] = useActionState(saveChannelDefaultAction, {});
  const [channel, setChannel] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  function chooseChannel(id: string) {
    setChannel(id);
    setSelected(existing[id] ?? []);
  }

  function toggle(id: string, on: boolean) {
    setSelected((list) => (on ? [...list, id] : list.filter((x) => x !== id)));
  }

  return (
    <form action={save} className={formStyles.form}>
      <label className={formStyles.field}>
        <span className={formStyles.label}>Channel</span>
        <span className={formStyles.control}>
          {channels ? (
            <select name="channel" value={channel} onChange={(e) => chooseChannel(e.target.value)} required className={formStyles.input}>
              <option value="" disabled>
                Choose a channel…
              </option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                  {existing[c.id] ? ' (has a default)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <input
              name="channel"
              value={channel}
              onChange={(e) => chooseChannel(e.target.value.trim())}
              placeholder="C0123ABCD"
              required
              autoComplete="off"
              spellCheck={false}
              className={formStyles.input}
            />
          )}
        </span>
        <span className={formStyles.help}>
          {channels
            ? channels.length === 0
              ? 'Botley is not in any channel yet. Invite it with /invite @Botley, then reload.'
              : 'Only channels Botley has been invited to are listed.'
            : "Slack's channel list could not be loaded, so enter the channel id (channel details > About)."}
        </span>
        {state.fieldErrors?.channel && <span className={formStyles.error}>{state.fieldErrors.channel}</span>}
      </label>

      <fieldset className={styles.sources}>
        <legend className={formStyles.label}>Data Sources</legend>
        {dataSources.length === 0 && <p className={styles.muted}>Add a Data Source first.</p>}
        {dataSources.map((ds) => (
          <label key={ds.id} className={styles.option}>
            <input
              type="checkbox"
              name="dataSourceIds"
              value={ds.id}
              checked={selected.includes(ds.id)}
              onChange={(e) => toggle(ds.id, e.target.checked)}
            />
            {ds.name}
            {!ds.queryable && <span className={styles.muted}> (no Exposed Datasets)</span>}
          </label>
        ))}
        <span className={formStyles.help}>
          Prompts in this channel only use these Data Sources. If none of them can be queried, Botley chooses among all.
        </span>
        {state.fieldErrors?.dataSourceIds && <span className={formStyles.error}>{state.fieldErrors.dataSourceIds}</span>}
      </fieldset>

      {state.message && <p className={formStyles.error}>{state.message}</p>}
      {state.saved && !saving && <p className={formStyles.success}>Saved. The next Prompt in that channel uses it.</p>}

      <div className={formStyles.actions}>
        <button type="submit" className="btn" disabled={saving}>
          {saving ? 'Saving…' : 'Save Channel Default'}
        </button>
      </div>
    </form>
  );
}
