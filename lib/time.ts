/**
 * Times as `device-history` takes them: a duration (`30s`, `15m`, `24h`, `7d`), and a moment, an
 * ISO 8601 time or a duration meaning that long ago.
 */

const SCALE: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Milliseconds, or undefined when it is not a duration. */
export const parseDuration = (text: string): number | undefined => {
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(text.trim());
  return match ? Number(match[1]) * SCALE[match[2]] : undefined;
};

/** A moment, or undefined when it is neither a duration nor a time. */
export const parseMoment = (text: string, now = Date.now()): Date | undefined => {
  const ago = parseDuration(text);
  if (ago !== undefined) return new Date(now - ago);
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? undefined : at;
};
