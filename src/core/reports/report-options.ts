/** Report form limits and schedule preset options, without dependencies, so client components can import them directly. */
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
/** Monthly presets stop at 28 so every month has the day. */
export const MONTHLY_MAX_DAY = 28;
export const REPORT_TITLE_MAX = 120;
