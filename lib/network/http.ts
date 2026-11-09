/**
 * The `http` driver's reading of a web API: a device is an address that answers JSON, and the
 * readings a person names in it. Its config:
 *
 * - `url` — the address, which may name the day and hour it is asked at: `{date}` (2026-11-09),
 *   `{year}`, `{month}`, `{day}` and `{hour}`, two digits each but the year, in EiN's time zone.
 *   A user and password in it (`http://admin:secret@192.0.2.20/status`) are sent as basic auth.
 * - `read` — the readings, `name=path [unit]`, separated by `;` or new lines:
 *   `temperature=current.temperature_2m °C; wind=current.wind_speed_10m m/s`.
 * - `interval` — how often it is asked: seconds, or `30s`, `15m`, `1h`; 5 minutes unless given,
 *   10 seconds at the least.
 * - `set` — the controls, `name=address [on/off]`, separated by `;` or new lines: the address asked
 *   to set it, absolute or from `url`'s, with `{value}` in it for the value as the device spells it
 *   (`power=cm?cmnd=Power%20{value} ON/OFF`). One with `on/off` is a switch, whose state is the
 *   reading of its name; one without `{value}` is an action, asked as it is.
 *
 * A path walks the answer: `a.b` a field, `['a b']` one whose name is not a word, `[0]` an item,
 * `[-1]` the last, `[from..to]` the item of a list whose `from` has come and whose `to` has not (an
 * hour's electricity price), `[from..]` the last whose `from` has come, and `.` the whole answer,
 * which may be plain text. A number written as text is read as a number.
 */

import { deviceName, type DeviceValue } from '@ein/api';
import { parseDuration } from '../time.ts';
import type { Fetch } from './adopt.ts';

type Step =
  | { kind: 'field'; name: string }
  | { kind: 'index'; index: number }
  | { kind: 'span'; from: string; to?: string };

/** One reading a person named: its endpoint, where it is in the answer, and its unit. */
type HttpReading = { name: string; label: string; path: Step[]; unit?: string };

/** One control a person named: its endpoint, the address that sets it, and how on and off are spelled. */
export type HttpControl = { name: string; label: string; address: string; on?: string; off?: string };

const DEFAULT_INTERVAL_MS = 300_000;
const MIN_INTERVAL_MS = 10_000;
const TIMEOUT_MS = 10_000;
/** The longest answer read: an API's, not a download. */
const MAX_BYTES = 1_000_000;

/** What a unit says is measured, for the device's class and the card's main reading. */
const CLASS_OF_UNIT: Record<string, string> = {
  '°C': 'temperature',
  '°F': 'temperature',
  W: 'power',
  kW: 'power',
  Wh: 'energy',
  kWh: 'energy',
  V: 'voltage',
  A: 'current',
  hPa: 'pressure',
};

export const deviceClassOfUnit = (unit: string | undefined): string | undefined => unit ? CLASS_OF_UNIT[unit] : undefined;

const parsePath = (text: string): Step[] => {
  if (text === '.') return [];
  const steps: Step[] = [];
  const part = /^(?:\.?([^.[\]\s'"]+)|\[\s*(?:'([^']*)'|"([^"]*)"|(-?\d+)|([^\]\s.]+)\s*\.\.\s*([^\]\s.]*))\s*\])/;
  let left = text;
  while (left) {
    const match = part.exec(left);
    if (!match) throw new Error(`the path ${text} is not understood`);
    if (match[1] !== undefined) steps.push({ kind: 'field', name: match[1] });
    else if (match[2] !== undefined || match[3] !== undefined) steps.push({ kind: 'field', name: match[2] ?? match[3] });
    else if (match[4] !== undefined) steps.push({ kind: 'index', index: Number(match[4]) });
    else steps.push({ kind: 'span', from: match[5], ...(match[6] ? { to: match[6] } : {}) });
    left = left.slice(match[0].length);
  }
  return steps;
};

/** The readings of a `read` config; throws, saying which, when one is not understood. */
export const parseReadings = (text: string): HttpReading[] => {
  const readings: HttpReading[] = [];
  for (const line of text.split(/[;\n]/).map((each) => each.trim()).filter(Boolean)) {
    const at = line.indexOf('=');
    const name = deviceName(line.slice(0, Math.max(at, 0)));
    if (at < 1 || !name) throw new Error(`a reading is name=path [unit], not '${line}'`);
    const [, path, unit] = /^((?:\[[^\]]*\]|[^\s[])*)\s*(.*)$/.exec(line.slice(at + 1).trim())!;
    if (!path) throw new Error(`the reading ${name} names no path`);
    if (readings.some((each) => each.name === name)) throw new Error(`the reading ${name} is named twice`);
    readings.push({ name, label: line.slice(0, at).trim(), path: parsePath(path), ...(unit ? { unit } : {}) });
  }
  if (!readings.length) throw new Error('read names no reading');
  return readings;
};

/** The controls of a `set` config; throws, saying which, when one is not understood. */
export const parseControls = (text: string): HttpControl[] => {
  const controls: HttpControl[] = [];
  for (const line of text.split(/[;\n]/).map((each) => each.trim()).filter(Boolean)) {
    const at = line.indexOf('=');
    const name = deviceName(line.slice(0, Math.max(at, 0)));
    if (at < 1 || !name) throw new Error(`a control is name=address [on/off], not '${line}'`);
    const [address, values, ...rest] = line.slice(at + 1).trim().split(/\s+/);
    if (!address) throw new Error(`the control ${name} names no address`);
    if (rest.length) throw new Error(`the control ${name} is name=address [on/off], not '${line}'`);
    if (controls.some((each) => each.name === name)) throw new Error(`the control ${name} is named twice`);
    const takesValue = address.includes('{value}');
    if (takesValue && !values) throw new Error(`the control ${name} puts in {value}, so it names how on and off are spelled: on/off`);
    if (!takesValue && values) throw new Error(`the control ${name} names ${values} but has no {value} in its address to put it in`);
    const [on, off] = values?.split('/') ?? [];
    if (values && !(on && off && values.split('/').length === 2)) throw new Error(`the control ${name} spells on and off as on/off, not '${values}'`);
    controls.push({ name, label: line.slice(0, at).trim(), address, ...(values ? { on, off } : {}) });
  }
  return controls;
};

/** The address that sets `control` to `value`, resolved from the device's `url`. */
export const controlAddress = (control: HttpControl, url: string, value: DeviceValue): string => {
  const spelled = value === true ? control.on : value === false ? control.off : undefined;
  if (control.on !== undefined && spelled === undefined) throw new Error(`${control.name} is switched on or off, not set to ${value}`);
  return new URL(control.address.replaceAll('{value}', encodeURIComponent(spelled ?? '')), url).href;
};

/** A switch's state from the reading of its name: on or off as the device spells them, or a boolean. */
export const switchState = (control: HttpControl, value: DeviceValue): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  const text = String(value).toLowerCase();
  if (text === control.on?.toLowerCase()) return true;
  if (text === control.off?.toLowerCase()) return false;
  return undefined;
};

/** How often a device of the http driver is asked, from its `interval`; throws when it is not a duration. */
export const intervalOf = (text: string | undefined): number => {
  if (!text?.trim()) return DEFAULT_INTERVAL_MS;
  const ms = /^\d+(\.\d+)?$/.test(text.trim()) ? Number(text) * 1000 : parseDuration(text);
  if (ms === undefined) throw new Error(`interval is seconds or a duration such as 15m, not '${text}'`);
  return Math.max(ms, MIN_INTERVAL_MS);
};

const two = (n: number): string => String(n).padStart(2, '0');

/** The address with the day and hour of `now` put in, in the process's time zone. */
export const expandUrl = (url: string, now: Date): string => {
  const parts: Record<string, string> = {
    year: String(now.getFullYear()),
    month: two(now.getMonth() + 1),
    day: two(now.getDate()),
    hour: two(now.getHours()),
  };
  parts.date = `${parts.year}-${parts.month}-${parts.day}`;
  return url.replace(/\{(date|year|month|day|hour)\}/g, (_, name: string) => parts[name]);
};

/** Checks a device's config as a person gave it; throws saying what is wrong. */
export const checkHttpConfig = (config: Record<string, string>): void => {
  if (!config.url) throw new Error('it needs url, the address to ask');
  const url = new URL(expandUrl(config.url, new Date()));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`url is http or https, not ${url.protocol}`);
  parseReadings(config.read ?? '');
  intervalOf(config.interval);
  for (const control of parseControls(config.set ?? '')) {
    const address = new URL(control.address.replaceAll('{value}', ''), url);
    if (address.protocol !== 'http:' && address.protocol !== 'https:') throw new Error(`the control ${control.name} is http or https, not ${address.protocol}`);
  }
};

const timeOf = (value: unknown): number => typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN;

const walk = (answer: unknown, path: Step[], now: number): unknown => {
  let at = answer;
  for (const step of path) {
    if (step.kind === 'field') {
      if (at === null || typeof at !== 'object' || Array.isArray(at)) return undefined;
      at = (at as Record<string, unknown>)[step.name];
    } else if (!Array.isArray(at)) {
      return undefined;
    } else if (step.kind === 'index') {
      at = at[step.index < 0 ? at.length + step.index : step.index];
    } else {
      const items: Record<string, unknown>[] = at.filter((item) => item !== null && typeof item === 'object');
      const begun = items.filter((item) => timeOf(item[step.from]) <= now);
      at = step.to ? begun.find((item) => now < timeOf(item[step.to!])) : begun.at(-1);
    }
  }
  return at;
};

/** A value as an endpoint keeps it; undefined for a list or an object, which no endpoint holds. */
const valueOf = (value: unknown): DeviceValue | undefined => {
  if (typeof value === 'string') {
    const number = value.trim() === '' ? NaN : Number(value);
    return Number.isFinite(number) ? number : value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean' || value === null) return value;
  return undefined;
};

/** Each reading's value in an answer, those it has; the answer is JSON, or text read as `.`. */
export const readAnswer = (body: string, readings: HttpReading[], now = Date.now()): Record<string, DeviceValue> => {
  let answer: unknown;
  try {
    answer = JSON.parse(body);
  } catch {
    answer = body.trim();
  }
  const values: Record<string, DeviceValue> = {};
  for (const reading of readings) {
    const value = valueOf(walk(answer, reading.path, now));
    if (value !== undefined) values[reading.name] = value;
  }
  return values;
};

/** Asks `url` and answers its body; throws when it does not answer, or answers with an error. */
export const fetchAnswer = async (fetcher: Fetch, address: string): Promise<string> => {
  const url = new URL(address);
  const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.9, */*;q=0.1' };
  if (url.username || url.password) {
    headers.authorization = `Basic ${btoa(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`)}`;
    url.username = '';
    url.password = '';
  }
  const response = await fetcher(url.href, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${url.host} answered ${response.status} ${response.statusText}`.trim());
  }
  const tooLong = () => new Error(`${url.host} answered more than ${MAX_BYTES / 1_000_000} MB`);
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel();
    throw tooLong();
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw tooLong();
  return new TextDecoder().decode(bytes);
};
