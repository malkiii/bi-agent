import { describe, expect, test } from 'vitest';
import { ValidationError } from '../errors';
import { describeSchedule, nextRunAt, validateSchedule } from './schedule';

// 2026-01-05 is a Monday.
const MONDAY_9_UTC = new Date('2026-01-05T09:00:00Z');

describe('nextRunAt', () => {
  test('a weekly preset runs on its weekday at its local time in the timezone', () => {
    expect(nextRunAt({ kind: 'weekly', weekday: 1, time: '09:00' }, 'Europe/Paris', MONDAY_9_UTC)).toEqual(
      new Date('2026-01-12T08:00:00Z'),
    );
  });

  test('a daily preset keeps its local time across a daylight-saving change', () => {
    // New York springs forward on 2026-03-08: 09:00 local is 14:00Z before, 13:00Z after.
    const schedule = { kind: 'daily', time: '09:00' } as const;
    const saturday = nextRunAt(schedule, 'America/New_York', new Date('2026-03-07T00:00:00Z'));
    expect(saturday).toEqual(new Date('2026-03-07T14:00:00Z'));
    expect(nextRunAt(schedule, 'America/New_York', saturday)).toEqual(new Date('2026-03-08T13:00:00Z'));
  });

  test('a monthly preset runs on its date', () => {
    expect(nextRunAt({ kind: 'monthly', day: 1, time: '06:30' }, 'UTC', MONDAY_9_UTC)).toEqual(new Date('2026-02-01T06:30:00Z'));
  });

  test('a cron expression runs at its next match in the timezone', () => {
    // Weekdays at 17:15 Tokyo (UTC+9) = 08:15Z; Monday 09:00Z is past it, so Tuesday.
    expect(nextRunAt({ kind: 'cron', expression: '15 17 * * 1-5' }, 'Asia/Tokyo', MONDAY_9_UTC)).toEqual(
      new Date('2026-01-06T08:15:00Z'),
    );
  });
});

describe('validateSchedule', () => {
  function fieldErrors(fn: () => unknown): Record<string, string> {
    try {
      fn();
    } catch (error) {
      if (error instanceof ValidationError) return { ...error.fieldErrors };
      throw error;
    }
    throw new Error('expected a ValidationError');
  }

  test('normalises a valid schedule and timezone', () => {
    expect(validateSchedule({ kind: 'weekly', weekday: 5, time: '7:05' }, ' Europe/Paris ')).toEqual({
      schedule: { kind: 'weekly', weekday: 5, time: '07:05' },
      timezone: 'Europe/Paris',
    });
    expect(validateSchedule({ kind: 'cron', expression: ' 0  9 * * 1 ' }, 'UTC').schedule).toEqual({
      kind: 'cron',
      expression: '0 9 * * 1',
    });
  });

  test('names each bad field', () => {
    expect(Object.keys(fieldErrors(() => validateSchedule({ kind: 'daily', time: '25:00' }, 'Mars/Olympus')))).toEqual(
      expect.arrayContaining(['time', 'timezone']),
    );
    expect(fieldErrors(() => validateSchedule({ kind: 'weekly', weekday: 7, time: '09:00' }, 'UTC'))).toHaveProperty('weekday');
    expect(fieldErrors(() => validateSchedule({ kind: 'monthly', day: 31, time: '09:00' }, 'UTC'))).toHaveProperty('day');
  });

  test('accepts only five-field cron expressions', () => {
    expect(fieldErrors(() => validateSchedule({ kind: 'cron', expression: '0 0 9 * * *' }, 'UTC'))).toHaveProperty('cron');
    expect(fieldErrors(() => validateSchedule({ kind: 'cron', expression: '99 * * * *' }, 'UTC'))).toHaveProperty('cron');
  });
});

test('describeSchedule says the schedule in words', () => {
  expect(describeSchedule({ kind: 'weekly', weekday: 1, time: '09:00' })).toBe('Every Monday at 09:00');
  expect(describeSchedule({ kind: 'monthly', day: 15, time: '18:00' })).toBe('Monthly on day 15 at 18:00');
  expect(describeSchedule({ kind: 'cron', expression: '0 9 * * 1-5' })).toBe('Cron 0 9 * * 1-5');
});
