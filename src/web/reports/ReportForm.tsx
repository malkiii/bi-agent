'use client';

import { useActionState, useEffect, useState } from 'react';
import type { SlackChannel } from '@/core';
import { MONTHLY_MAX_DAY, REPORT_TITLE_MAX, WEEKDAYS } from '@/core/reports/report-options';
import { useBotley } from '@/web/botley/BotleyProvider';
import formStyles from '@/web/components/DataSourceForm.module.css';
import { createReportAction } from './actions';
import styles from './reports.module.css';

export interface SavedQuestionOption {
  id: string;
  title: string;
}

type ScheduleKind = 'daily' | 'weekly' | 'monthly' | 'cron';

/**
 * New Report: where its queries come from (a Prompt the agent answers now, or a Saved Question),
 * its schedule (preset or cron, in a timezone that defaults to the browser's) and destination.
 */
export function ReportForm({
  savedQuestions,
  channels,
  initialSavedQuestionId,
}: {
  savedQuestions: SavedQuestionOption[];
  /** Null when Slack's channel list could not be loaded. */
  channels: SlackChannel[] | null;
  initialSavedQuestionId?: string;
}) {
  const [state, save, saving] = useActionState(createReportAction, {});
  const [source, setSource] = useState<'prompt' | 'savedQuestion'>(initialSavedQuestionId ? 'savedQuestion' : 'prompt');
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>('weekly');
  const [destinationKind, setDestinationKind] = useState<'channel' | 'dm'>('channel');
  const [timezone, setTimezone] = useState('UTC');
  const { setBotleyState } = useBotley();
  const errors = state.fieldErrors ?? {};

  useEffect(() => {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the browser's timezone is only known after hydration
    if (detected) setTimezone(detected);
  }, []);

  useEffect(() => {
    if (saving) setBotleyState('thinking');
    else if (state.message) setBotleyState('error');
  }, [saving, state, setBotleyState]);

  return (
    <form action={save} className={formStyles.form}>
      <fieldset className={styles.fieldset}>
        <legend className={formStyles.label}>Queries from</legend>
        <label className={styles.option}>
          <input type="radio" name="queriesFrom" value="prompt" checked={source === 'prompt'} onChange={() => setSource('prompt')} /> A
          new Prompt
        </label>
        <label className={styles.option}>
          <input
            type="radio"
            name="queriesFrom"
            value="savedQuestion"
            checked={source === 'savedQuestion'}
            onChange={() => setSource('savedQuestion')}
            disabled={savedQuestions.length === 0}
          />{' '}
          A Saved Question
        </label>
      </fieldset>

      {source === 'prompt' ? (
        <label className={formStyles.field}>
          <span className={formStyles.label}>Prompt</span>
          <textarea name="prompt" rows={3} required className={formStyles.input} placeholder="Weekly sales by region, with a chart" />
          <span className={formStyles.help}>Botley answers it once. You check the Answer, then approve it to pin its queries.</span>
          {errors.prompt && <span className={formStyles.error}>{errors.prompt}</span>}
        </label>
      ) : (
        <label className={formStyles.field}>
          <span className={formStyles.label}>Saved Question</span>
          <select name="savedQuestionId" defaultValue={initialSavedQuestionId ?? ''} required className={formStyles.input}>
            <option value="" disabled>
              Choose a Saved Question…
            </option>
            {savedQuestions.map((q) => (
              <option key={q.id} value={q.id}>
                {q.title}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className={formStyles.field}>
        <span className={formStyles.label}>Title</span>
        <input name="title" className={formStyles.input} placeholder="Defaults to the Prompt" maxLength={REPORT_TITLE_MAX} />
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
            <select name="weekday" defaultValue="1" className={formStyles.input} aria-label="Day of the week">
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  on {d}
                </option>
              ))}
            </select>
          )}
          {scheduleKind === 'monthly' && (
            <select name="day" defaultValue="1" className={formStyles.input} aria-label="Day of the month">
              {Array.from({ length: MONTHLY_MAX_DAY }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  on day {i + 1}
                </option>
              ))}
            </select>
          )}
          {scheduleKind === 'cron' ? (
            <input name="cron" required className={`${formStyles.input} ${styles.mono}`} placeholder="0 9 * * 1-5" aria-label="Cron expression" />
          ) : (
            <input name="time" type="time" defaultValue="09:00" required className={formStyles.input} aria-label="Time" />
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
          <input type="radio" name="destinationKind" value="dm" checked={destinationKind === 'dm'} onChange={() => setDestinationKind('dm')} />{' '}
          Me, in a DM
        </label>
        {destinationKind === 'channel' &&
          (channels ? (
            <select name="channel" defaultValue="" required className={formStyles.input} aria-label="Channel">
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
            <input name="channel" required placeholder="C0123ABCD" className={formStyles.input} aria-label="Channel id" spellCheck={false} />
          ))}
        {destinationKind === 'channel' && (
          <span className={formStyles.help}>
            {channels
              ? channels.length === 0
                ? 'Botley is not in any channel yet. Invite it with /invite @Botley, then reload.'
                : 'Only channels Botley has been invited to are listed.'
              : "Slack's channel list could not be loaded, so enter the channel id (channel details > About)."}
          </span>
        )}
        {errors.destination && <span className={formStyles.error}>{errors.destination}</span>}
      </fieldset>

      {state.message && !errors.destination && <p className={formStyles.error}>{state.message}</p>}

      <div className={formStyles.actions}>
        <button type="submit" className="btn" disabled={saving}>
          {saving ? (source === 'prompt' ? 'Botley is answering…' : 'Saving…') : 'Create Report'}
        </button>
      </div>
    </form>
  );
}
