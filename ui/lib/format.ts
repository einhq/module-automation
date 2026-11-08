/** How the device pages write a value: on and off for a state, a number with its unit, a dash for none. */

import type { Value } from '../../lib/api.ts';

export const readingText = (value: Value | undefined, unit?: string): string => {
  if (value === null || value === undefined) return '–';
  if (value === true) return 'on';
  if (value === false) return 'off';
  if (typeof value === 'number') {
    const shown = Math.abs(value) >= 100 ? value.toFixed(0) : String(Number(value.toFixed(2)));
    return unit ? `${shown} ${unit}` : shown;
  }
  return unit ? `${value} ${unit}` : value;
};

/** How long ago `at` was, in a few words. */
export const agoText = (at: string | undefined, now = Date.now()): string => {
  if (!at) return 'never';
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
};
