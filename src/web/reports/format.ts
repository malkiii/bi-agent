import type { ReportStatus } from '@/core';

/** "Mon 12 Jan 2026, 09:00" in `timezone` (falls back to UTC for an unknown zone). */
export function formatInZone(date: Date, timezone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: timezone }).format(date);
  } catch {
    return `${new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(date)} UTC`;
  }
}

const STATUS_LABELS: Record<ReportStatus, string> = {
  draft: 'draft',
  active: 'active',
  paused: 'paused',
  needsReapproval: 'needs re-approval',
};

/** A Report's status as people read it. */
export function statusLabel(status: ReportStatus): string {
  return STATUS_LABELS[status];
}
