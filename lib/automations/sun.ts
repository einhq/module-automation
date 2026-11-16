/**
 * Times of day that follow the sun: sunrise and sunset, when the sun's upper edge meets the horizon,
 * and dawn and dusk, when its centre is 6° below it (civil twilight), at a node's location, with an
 * offset (`sunset-30m`). Reckoned as in the NOAA's simplified equations, within a minute or two
 * away from the poles.
 *
 * Import-free, so the editor's simulation reckons them as the engine does.
 */

type SunEvent = 'sunrise' | 'sunset' | 'dawn' | 'dusk';

/** Latitude and longitude in degrees, north and east positive. */
export type Location = [number, number];

/** A time of day as a node's settings hold it: minutes since midnight, or a sun event and an offset in ms. */
export type TimeOfDay = number | { sun: SunEvent; offset: number };

type Local = { day: string; minute: number };

const DAY = 86_400_000;
const RAD = Math.PI / 180;
const J1970 = 2440587.5;
const J2000 = 2451545;
/** The sun's altitude at each event: refraction and its radius at sunrise and sunset, civil twilight at dawn and dusk. */
const ALTITUDE: Record<SunEvent, number> = { sunrise: -0.833, sunset: -0.833, dawn: -6, dusk: -6 };
const RISING: Record<SunEvent, boolean> = { sunrise: true, sunset: false, dawn: true, dusk: false };

/**
 * When `event` comes on the solar day nearest `ms` at `location`, in ms; or `up` or `down` when the
 * sun stays above or below its altitude all that day, as in a summer or winter near the poles.
 */
export const sunEvent = (ms: number, [lat, lng]: Location, event: SunEvent): number | 'up' | 'down' => {
  const lw = -lng * RAD;
  const phi = lat * RAD;
  const cycle = Math.round(ms / DAY + J1970 - J2000 - 0.0009 - lw / (2 * Math.PI));
  const approx = 0.0009 + lw / (2 * Math.PI) + cycle;
  const anomaly = RAD * (357.5291 + 0.98560028 * approx);
  const center = RAD * (1.9148 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly) + 0.0003 * Math.sin(3 * anomaly));
  const longitude = anomaly + center + RAD * 102.9372 + Math.PI;
  const declination = Math.asin(Math.sin(longitude) * Math.sin(RAD * 23.4397));
  const julian = (days: number) => J2000 + days + 0.0053 * Math.sin(anomaly) - 0.0069 * Math.sin(2 * longitude);
  const transit = julian(approx);
  const cosHour = (Math.sin(ALTITUDE[event] * RAD) - Math.sin(phi) * Math.sin(declination)) / (Math.cos(phi) * Math.cos(declination));
  if (cosHour < -1) return 'up';
  if (cosHour > 1) return 'down';
  const set = julian(0.0009 + (Math.acos(cosHour) + lw) / (2 * Math.PI) + cycle);
  const julianDay = RISING[event] ? transit - (set - transit) : set;
  return Math.round((julianDay - J1970) * DAY);
};

/** `sunset`, `dawn+15m`, `sunrise - 1h`: the event and the offset's sign and duration, as written. */
export const parseSunTime = (text: string): { sun: SunEvent; sign: 1 | -1; offset?: string } | undefined => {
  const match = /^(sunrise|sunset|dawn|dusk)\s*(?:([+-])\s*(\S+))?$/.exec(text.trim().toLowerCase());
  if (!match) return undefined;
  return { sun: match[1] as SunEvent, sign: match[2] === '-' ? -1 : 1, ...(match[3] ? { offset: match[3] } : {}) };
};

/**
 * The minute of the day `local` is in, at `now`, that `time` falls on, and whether it comes that day.
 * A sun time is the event of the solar day before, of that day or of the day after whose time with
 * its offset falls on that day. One that does not come (the sun stays up or down, or the offset
 * takes it to another day) is the day's start or end, as a window from or until it needs: sunset
 * when the sun never sets is the end of the day, sunrise the start.
 */
export const minuteOf = (time: TimeOfDay, location: Location | undefined, now: number, local: Local, localTime: (ms: number) => Local): { minute: number; comes: boolean } => {
  if (typeof time === 'number') return { minute: time, comes: true };
  if (!location) return { minute: 0, comes: false };
  const noon = now + (720 - local.minute) * 60_000;
  let today: number | 'up' | 'down' = 'up';
  for (const shift of [-1, 0, 1]) {
    const at = sunEvent(noon + shift * DAY, location, time.sun);
    if (shift === 0) today = at;
    if (typeof at !== 'number') continue;
    const there = localTime(at + time.offset);
    if (there.day === local.day) return { minute: there.minute, comes: true };
  }
  if (typeof today === 'number') return { minute: localTime(today + time.offset).day < local.day ? 0 : 1440, comes: false };
  return { minute: (today === 'up') === RISING[time.sun] ? 0 : 1440, comes: false };
};
