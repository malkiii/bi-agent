'use client';

import { useActionState, useEffect, useState } from 'react';
import type { KpiAlertCondition, ReportDestination, ReportSchedule, SlackChannel } from '@/core';
import { HOURLY_CRON, KPI_NAME_MAX } from '@/core/kpis/kpi-options';
import { WEEKDAYS } from '@/core/reports/report-options';
import { useBIBot } from '@/web/bibot/BIBotProvider';
import formStyles from '@/web/components/DataSourceForm.module.css';
import styles from '@/web/reports/reports.module.css';
import { createAlertAction, updateAlertAction } from './actions';

type Frequency = 'hourly' | 'daily' | 'weekly' | 'cron';

/** An existing Alert's settings, to edit. */
export interface EditableAlert {
  id: string;
  name: string;
  condition: KpiAlertCondition;
  schedule: ReportSchedule;
  timezone: string;
  destination: ReportDestination;
  /** Who gets a DM destination: the Alert's creator, e.g. "You" or "Ada". */
  dmRecipient: string;
}

function frequencyOf(schedule: ReportSchedule | undefined): Frequency {
  if (!schedule) return 'hourly';
  if (schedule.kind === 'cron') return schedule.expression === HOURLY_CRON ? 'hourly' : 'cron';
  return schedule.kind === 'monthly' ? 'cron' : schedule.kind;
}

/**
 * New KPI Alert on `kpiId`: a condition (above, below, or a % change since the previous check),
 * how often to check (in a timezone that defaults to the browser's) and where to post.
 * With `alert`, edits that Alert instead.
 */
export function AlertForm({ kpiId, alert, channels }: { kpiId?: string; alert?: EditableAlert; channels: SlackChannel[] | null }) {
  const [state, save, saving] = useActionState(alert ? updateAlertAction : createAlertAction, {});
  const condition = alert?.condition;
  const schedule = alert?.schedule;
  const [conditionKind, setConditionKind] = useState<KpiAlertCondition['kind']>(condition?.kind ?? 'above');
  const [frequency, setFrequency] = useState<Frequency>(frequencyOf(schedule));
  const [destinationKind, setDestinationKind] = useState<'channel' | 'dm'>(alert?.destination.kind ?? 'channel');
  const [timezone, setTimezone] = useState(alert?.timezone ?? 'UTC');
  const { setBIBotState } = useBIBot();
  const errors = state.fieldErrors ?? {};
  const editing = alert !== undefined;
  const initialChannel = alert?.destination.kind === 'channel' ? alert.destination.channel : '';

  useEffect(() => {
    if (editing) return;
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the browser's timezone is only known after hydration
    if (detected) setTimezone(detected);
  }, [editing]);

  useEffect(() => {
    if (state.message) setBIBotState('error');
  }, [state, setBIBotState]);

  return (
    <form action={save} className={formStyles.form}>
      {alert ? <input type="hidden" name="id" value={alert.id} /> : <input type="hidden" name="kpiId" value={kpiId} />}

      <fieldset className={styles.fieldset}>
        <legend className={formStyles.label}>Alert when the KPI</legend>
        <div className={styles.row}>
          <select
            name="conditionKind"
            value={conditionKind}
            onChange={(e) => setConditionKind(e.target.value as KpiAlertCondition['kind'])}
            className={formStyles.input}
            aria-label="Condition"
          >
            <option value="above">goes above</option>
            <option value="below">goes below</option>
            <option value="change">changes by a %</option>
          </select>
          {conditionKind === 'change' ? (
            <>
              <select
                name="direction"
                defaultValue={condition?.kind === 'change' ? condition.direction : 'either'}
                className={formStyles.input}
                aria-label="Direction"
              >
                <option value="either">up or down</option>
                <option value="up">up</option>
                <option value="down">down</option>
              </select>
              <input
                name="percent"
                type="number"
                min="0"
                step="any"
                required
                defaultValue={condition?.kind === 'change' ? condition.percent : 10}
                className={formStyles.input}
                aria-label="Percent"
              />
            </>
          ) : (
            <input
              name="value"
              type="number"
              step="any"
              required
              defaultValue={condition && condition.kind !== 'change' ? condition.value : undefined}
              className={formStyles.input}
              aria-label="Value"
            />
          )}
        </div>
        {conditionKind === 'change' && <span className={formStyles.help}>Compared with the value at the previous check.</span>}
        {errors.condition && <span className={formStyles.error}>{errors.condition}</span>}
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={formStyles.label}>Check</legend>
        <div className={styles.row}>
          <select
            name="frequency"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as Frequency)}
            className={formStyles.input}
            aria-label="Frequency"
          >
            <option value="hourly">Every hour</option>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="cron">Cron expression</option>
          </select>
          {frequency === 'weekly' && (
            <select
              name="weekday"
              defaultValue={schedule?.kind === 'weekly' ? schedule.weekday : 1}
              className={formStyles.input}
              aria-label="Day of the week"
            >
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  on {d}
                </option>
              ))}
            </select>
          )}
          {(frequency === 'daily' || frequency === 'weekly') && (
            <input
              name="time"
              type="time"
              defaultValue={schedule && schedule.kind !== 'cron' ? schedule.time : '09:00'}
              required
              className={formStyles.input}
              aria-label="Time"
            />
          )}
          {frequency === 'cron' && (
            <input
              name="cron"
              defaultValue={schedule?.kind === 'cron' && schedule.expression !== HOURLY_CRON ? schedule.expression : undefined}
              required
              className={`${formStyles.input} ${styles.mono}`}
              placeholder="*/15 8-18 * * 1-5"
              aria-label="Cron expression"
            />
          )}
        </div>
        {['time', 'weekday', 'cron', 'schedule'].map(
          (key) =>
            errors[key] && (
              <span key={key} className={formStyles.error}>
                {errors[key]}
              </span>
            ),
        )}
      </fieldset>

      <label className={formStyles.field}>
        <span className={formStyles.label}>Timezone</span>
        <input
          name="timezone"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          required
          className={formStyles.input}
          spellCheck={false}
          autoComplete="off"
        />
        {errors.timezone && <span className={formStyles.error}>{errors.timezone}</span>}
      </label>

      <fieldset className={styles.fieldset}>
        <legend className={formStyles.label}>Post alerts to</legend>
        <label className={styles.option}>
          <input type="radio" name="destinationKind" value="channel" checked={destinationKind === 'channel'} onChange={() => setDestinationKind('channel')} />{' '}
          A channel
        </label>
        <label className={styles.option}>
          <input type="radio" name="destinationKind" value="dm" checked={destinationKind === 'dm'} onChange={() => setDestinationKind('dm')} />{' '}
          {alert ? `${alert.dmRecipient}, in a DM` : 'Me, in a DM'}
        </label>
        {destinationKind === 'channel' &&
          (channels ? (
            <select name="channel" defaultValue={initialChannel} required className={formStyles.input} aria-label="Channel">
              <option value="" disabled>
                Choose a channel…
              </option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              name="channel"
              defaultValue={initialChannel}
              required
              placeholder="C0123ABCD"
              className={formStyles.input}
              aria-label="Channel id"
              spellCheck={false}
            />
          ))}
        {destinationKind === 'channel' && channels?.length === 0 && (
          <span className={formStyles.help}>BIBot is not in any channel yet. Invite it with /invite @BIBot, then reload.</span>
        )}
        {errors.destination && <span className={formStyles.error}>{errors.destination}</span>}
      </fieldset>

      <label className={formStyles.field}>
        <span className={formStyles.label}>Name</span>
        <input name="name" defaultValue={alert?.name} className={formStyles.input} placeholder="Defaults to the KPI and condition" maxLength={KPI_NAME_MAX} />
      </label>

      {state.message && !errors.destination && <p className={formStyles.error}>{state.message}</p>}

      <div className={formStyles.actions}>
        <button type="submit" className="btn" disabled={saving}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Add Alert'}
        </button>
      </div>
    </form>
  );
}
