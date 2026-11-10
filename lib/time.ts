/**
 * Durations as automations take them: `30s`, `15m`, `24h`, `7d`; and a moment as the clock on the
 * wall of a time zone says it.
 */

const SCALE: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Milliseconds, or undefined when it is not a duration. */
export const parseDuration = (text: string): number | undefined => {
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(text.trim());
  return match ? Number(match[1]) * SCALE[match[2]] : undefined;
};

/** The day, the minute of the day and the weekday (Monday 0) at `ms`, in `timeZone`. */
export const localTimeIn = (ms: number, timeZone: string): { day: string; minute: number; weekday: number } => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    minute: Number(get('hour')) * 60 + Number(get('minute')),
    weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')),
  };
};
