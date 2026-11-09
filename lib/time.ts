/**
 * Durations as automations take them: `30s`, `15m`, `24h`, `7d`.
 */

const SCALE: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Milliseconds, or undefined when it is not a duration. */
export const parseDuration = (text: string): number | undefined => {
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(text.trim());
  return match ? Number(match[1]) * SCALE[match[2]] : undefined;
};
