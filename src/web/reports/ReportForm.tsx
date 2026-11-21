'use client';

import { useActionState, useEffect, useState } from 'react';
import type { ReportDestination, ReportSchedule, SlackChannel } from '@/core';
import { MONTHLY_MAX_DAY, REPORT_TITLE_MAX, WEEKDAYS } from '@/core/reports/report-options';
import { useBIBot } from '@/web/bibot/BIBotProvider';
import formStyles from '@/web/components/DataSourceForm.module.css';
import { createReportAction, updateReportAction } from './actions';
import styles from './reports.module.css';

type ScheduleKind = 'daily' | 'weekly' | 'monthly' | 'cron';

/** The settings of an existing Report, to edit. Its queries and Prompt can't be changed here. */
export interface EditableReport {
  id: string;
  title: string;
  schedule: ReportSchedule;
  timezone: string;
  destination: ReportDestination;
  /** Who gets a DM destination: the Report's creator, e.g. "You" or "Ada". */
  dmRecipient: string;
}

/**
 * New Report: the Prompt the agent answers now, its schedule (preset or cron, in a timezone that defaults to the browser's) and destination.
 * With `report`, edits that Report's title, schedule, timezone and destination instead.
 */
export function ReportForm({
  channels,
  report,
}: {
  /** Null when Slack's channel list could not be loaded. */
  channels: SlackChannel[] | null;
  report?: EditableReport;
}) {
  const [state, save, saving] = useActionState(report ? updateReportAction : createReportAction, {});
  const schedule = report?.schedule;
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>(schedule?.kind ?? 'weekly');
  const [destinationKind, setDestinationKind] = useState<'channel' | 'dm'>(report?.destination.kind ?? 'channel');
  const [timezone, setTimezone] = useState(report?.timezone ?? 'UTC');
  const { setBIBotState } = useBIBot();
  const errors = state.fieldErrors ?? {};
  const editing = report !== undefined;
  const initialChannel = report?.destination.kind === 'channel' ? report.destination.channel : '';

  useEffect(() => {
    if (editing) return;
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the browser's timezone is only known after hydration
    if (detected) setTimezone(detected);
  }, [editing]);

  useEffect(() => {
    if (saving) setBIBotState('thinking');
    else if (state.message) setBIBotState('error');
  }, [saving, state, setBIBotState]);

  return (
    <form action={save} className={formStyles.form}>
      {report && <input type="hidden" name="id" value={report.id} />}
      {!editing && (
        <label className={formStyles.field}>
          <span className={formStyles.label}>Prompt</span>
          <textarea name="prompt" rows={3} required className={formStyles.input} placeholder="Weekly sales by region, with a chart" />
          <span className={formStyles.help}>BIBot answers it once. You check the Answer, then approve it to pin its queries.</span>
          {errors.prompt && <span className={formStyles.error}>{errors.prompt}</span>}
        </label>
      )}

      <label className={formStyles.field}>
        <span className={formStyles.label}>Title</span>
        <input
          name="title"
          defaultValue={report?.title}
          className={formStyles.input}
          placeholder="Defaults to the Prompt"
          maxLength={REPORT_TITLE_MAX}
        />
        {errors.title && <span className={formStyles.error}>{errors.title}</span>}
      </label>

      <fieldset className={styles.fieldset}>
        <legend className={formStyles.label}>Schedule</legend>
        <div className={styles.row}>
          <select
            name="scheduleKind"
            value={scheduleKind}
            onChange={(e) => setScheduleKind(e.target.value as ScheduleKind)}
            className={formStyles.input}
            aria-label="Repeat"
          >
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="monthly">Every month</option>
            <option value="cron">Cron expression</option>
          </select>
          {scheduleKind === 'weekly' && (
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
          {scheduleKind === 'monthly' && (
            <select
              name="day"
              defaultValue={schedule?.kind === 'monthly' ? schedule.day : 1}
              className={formStyles.input}
              aria-label="Day of the month"
            >
              {Array.from({ length: MONTHLY_MAX_DAY }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  on day {i + 1}
                </option>
              ))}
            </select>
          )}
          {scheduleKind === 'cron' ? (
            <input
              name="cron"
              defaultValue={schedule?.kind === 'cron' ? schedule.expression : undefined}
              required
              className={`${formStyles.input} ${styles.mono}`}
              placeholder="0 9 * * 1-5"
              aria-label="Cron expression"
            />
          ) : (
            <input
              name="time"
              type="time"
              defaultValue={schedule && schedule.kind !== 'cron' ? schedule.time : '09:00'}
              required
              className={formStyles.input}
              aria-label="Time"
            />
          )}
        </div>
        {scheduleKind === 'cron' && (
          <span className={formStyles.help}>Five fields: minute hour day-of-month month day-of-week. 0 9 * * 1-5 is 09:00 on weekdays.</span>
        )}
        {['time', 'weekday', 'day', 'cron', 'schedule'].map(
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
        <span className={formStyles.help}>An IANA timezone such as Europe/Paris. Defaults to your browser&apos;s.</span>
        {errors.timezone && <span className={formStyles.error}>{errors.timezone}</span>}
      </label>

      <fieldset className={styles.fieldset}>
        <legend className={formStyles.label}>Send Report Runs to</legend>
        <label className={styles.option}>
          <input
            type="radio"
            name="destinationKind"
            value="channel"
            checked={destinationKind === 'channel'}
            onChange={() => setDestinationKind('channel')}
          />{' '}
          A channel
        </label>
        <label className={styles.option}>
          <input
            type="radio"
            name="destinationKind"
            value="dm"
            checked={destinationKind === 'dm'}
            onChange={() => setDestinationKind('dm')}
          />{' '}
          {report ? `${report.dmRecipient}, in a DM` : 'Me, in a DM'}
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
        {destinationKind === 'channel' && (
          <span className={formStyles.help}>
            {channels
              ? channels.length === 0
                ? 'BIBot is not in any channel yet. Invite it with /invite @BIBot, then reload.'
                : 'Only channels BIBot has been invited to are listed.'
              : "Slack's channel list could not be loaded, so enter the channel id (channel details > About)."}
          </span>
        )}
        {errors.destination && <span className={formStyles.error}>{errors.destination}</span>}
      </fieldset>

      {state.message && !errors.destination && <p className={formStyles.error}>{state.message}</p>}

      <div className={formStyles.actions}>
        <button type="submit" className="btn" disabled={saving}>
          {saving ? (!editing ? 'BIBot is answering…' : 'Saving…') : editing ? 'Save changes' : 'Create Report'}
        </button>
      </div>
    </form>
  );
}
