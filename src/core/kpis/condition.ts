/**
 * KPI Alert conditions: above or below a value, or a % change compared with the previous check.
 * Pure, with no dependencies, so client components can import them directly.
 */

export type KpiAlertCondition =
  | { kind: 'above'; value: number }
  | { kind: 'below'; value: number }
  | { kind: 'change'; direction: 'up' | 'down' | 'either'; /** Positive, e.g. 10 for 10%. */ percent: number };

export const CHANGE_DIRECTIONS = ['up', 'down', 'either'] as const;

/** Whether `value` meets the condition; a % change needs a non-zero previous value. */
export function conditionMet(condition: KpiAlertCondition, value: number, previous: number | null): boolean {
  switch (condition.kind) {
    case 'above':
      return value > condition.value;
    case 'below':
      return value < condition.value;
    case 'change': {
      if (previous === null || previous === 0) return false;
      const change = ((value - previous) / Math.abs(previous)) * 100;
      if (condition.direction === 'up') return change >= condition.percent;
      if (condition.direction === 'down') return -change >= condition.percent;
      return Math.abs(change) >= condition.percent;
    }
  }
}

/** "above 40", "down 10% or more since the previous check". */
export function describeCondition(condition: KpiAlertCondition): string {
  switch (condition.kind) {
    case 'above':
      return `above ${formatNumber(condition.value)}`;
    case 'below':
      return `below ${formatNumber(condition.value)}`;
    case 'change': {
      const by = `${formatNumber(condition.percent)}% or more since the previous check`;
      return condition.direction === 'either' ? `changes by ${by}` : `${condition.direction} ${by}`;
    }
  }
}

/** Checks a condition from a form or API; the error names the `condition` field. */
export function validateCondition(input: KpiAlertCondition): { ok: true; condition: KpiAlertCondition } | { ok: false; error: string } {
  switch (input?.kind) {
    case 'above':
    case 'below':
      if (!Number.isFinite(input.value)) return { ok: false, error: 'Enter the value to compare with.' };
      return { ok: true, condition: { kind: input.kind, value: input.value } };
    case 'change':
      if (!CHANGE_DIRECTIONS.includes(input.direction)) return { ok: false, error: 'Choose up, down or either.' };
      if (!Number.isFinite(input.percent) || input.percent <= 0) return { ok: false, error: 'Enter a percentage above 0.' };
      return { ok: true, condition: { kind: 'change', direction: input.direction, percent: input.percent } };
    default:
      return { ok: false, error: 'Choose above, below or a % change.' };
  }
}

/** Up to 4 decimals, without trailing zeros: 37.75, 1234567, 0.1235. */
export function formatNumber(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}
