/**
 * Report schedules: a preset (daily, weekly on a weekday, monthly on a date, at a local time)
 * or a five-field cron expression, always read in the Report's IANA timezone.
 *
 *   const { schedule, timezone } = validateSchedule(input, 'Europe/Paris'); // ValidationError on bad input
 *   nextRunAt(schedule, timezone, clock.now());                              // first run strictly after
 */
import { Cron } from 'croner';
import { ValidationError } from '../errors';
import { MONTHLY_MAX_DAY, WEEKDAYS } from './report-options';

export { MONTHLY_MAX_DAY, WEEKDAYS };

export type ReportSchedule =
  | { kind: 'daily'; /** Local `HH:MM`. */ time: string }
  | { kind: 'weekly'; /** 0 = Sunday … 6 = Saturday. */ weekday: number; time: string }
  | { kind: 'monthly'; /** 1–28, so every month has it. */ day: number; time: string }
  | { kind: 'cron'; /** Five fields: minute hour day-of-month month day-of-week. */ expression: string };


/** The first time the schedule fires strictly after `after`. */
export function nextRunAt(schedule: ReportSchedule, timezone: string, after: Date): Date {
  const next = new Cron(cronOf(schedule), { timezone, paused: true }).nextRun(after);
  if (!next) throw new ValidationError('This schedule never runs.', { schedule: 'Never runs' });
  return next;
}

/**
 * Checks and normalises a schedule and timezone from a form or API. Throws ValidationError
 * naming the bad fields (`time`, `weekday`, `day`, `cron`, `timezone`, `schedule`).
 */
export function validateSchedule(input: ReportSchedule, timezone: string): { schedule: ReportSchedule; timezone: string } {
  const errors: Record<string, string> = {};
  const tz = timezone.trim();
  if (!isTimezone(tz)) errors.timezone = 'Choose a valid timezone, e.g. Europe/Paris.';

  let schedule: ReportSchedule | null = null;
  switch (input.kind) {
    case 'daily':
    case 'weekly':
    case 'monthly': {
      const time = normaliseTime(input.time);
      if (!time) errors.time = 'Use a 24-hour time such as 09:00.';
      if (input.kind === 'daily') schedule = { kind: 'daily', time: time ?? '' };
      if (input.kind === 'weekly') {
        if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) errors.weekday = 'Choose a day of the week.';
        schedule = { kind: 'weekly', weekday: input.weekday, time: time ?? '' };
      }
      if (input.kind === 'monthly') {
        if (!Number.isInteger(input.day) || input.day < 1 || input.day > MONTHLY_MAX_DAY) {
          errors.day = `Choose a day from 1 to ${MONTHLY_MAX_DAY}.`;
        }
        schedule = { kind: 'monthly', day: input.day, time: time ?? '' };
      }
      break;
    }
    case 'cron': {
      const expression = (input.expression ?? '').trim().replace(/\s+/g, ' ');
      const cronError = checkCron(expression);
      if (cronError) errors.cron = cronError;
      schedule = { kind: 'cron', expression };
      break;
    }
    default:
      errors.schedule = 'Choose daily, weekly, monthly or cron.';
  }

  if (Object.keys(errors).length > 0 || !schedule) throw new ValidationError('Check the schedule.', errors);
  return { schedule, timezone: tz };
}

/** "Every Monday at 09:00", "Cron 0 9 * * 1-5". */
export function describeSchedule(schedule: ReportSchedule): string {
  switch (schedule.kind) {
    case 'daily':
      return `Every day at ${schedule.time}`;
    case 'weekly':
      return `Every ${WEEKDAYS[schedule.weekday] ?? '?'} at ${schedule.time}`;
    case 'monthly':
      return `Monthly on day ${schedule.day} at ${schedule.time}`;
    case 'cron':
      return `Cron ${schedule.expression}`;
  }
}

function cronOf(schedule: ReportSchedule): string {
  if (schedule.kind === 'cron') return schedule.expression;
  const [hour, minute] = schedule.time.split(':').map(Number);
  if (schedule.kind === 'daily') return `${minute} ${hour} * * *`;
  if (schedule.kind === 'weekly') return `${minute} ${hour} * * ${schedule.weekday}`;
  return `${minute} ${hour} ${schedule.day} * *`;
}

function normaliseTime(time: string | undefined): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec((time ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${match[2]}`;
}

function checkCron(expression: string): string | null {
  if (expression.split(' ').length !== 5) return 'Use five fields: minute hour day-of-month month day-of-week.';
  try {
    if (!new Cron(expression, { paused: true }).nextRun()) return 'This cron expression never runs.';
    return null;
  } catch {
    return 'This is not a valid cron expression.';
  }
}

function isTimezone(timezone: string): boolean {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
