/**
 * A rule, as its YAML file says it, and when one of its triggers fires or a condition holds.
 *
 *   description: The hall lamp follows the porch button
 *   when:                          # one trigger, or a list of them: any one fires the rule
 *     event: porch-button/input-0  # a press; `is: single` for one kind of press
 *   if:                            # all must hold, on the endpoints' latest values
 *     - state: hall-sensor/illuminance
 *       below: 30
 *   then:                          # command lines, run in order as the rule file's owner
 *     - echo toggle > /dev/hall-plug/switch-0
 *   cooldown: 5s                   # the least time between two runs
 *
 * Triggers: `state: <device>/<endpoint>` with any of `to`, `from`, `above`, `below` (fires when the
 * value comes to it, not while it stays) and `for: 10m` (it held that long); `event:` with `is`;
 * `online: <device>` with `is: true|false`; `at: "07:30"` (every day, in the system's time zone);
 * `every: 15m`. Conditions: `state:` with `is`, `not`, `above`, `below`; `online:` with `is`.
 */

import type { DeviceValue } from '@ein/api';
import { parseDuration } from './time.ts';

type StateTrigger = {
  kind: 'state';
  device: string;
  endpoint: string;
  to?: DeviceValue;
  from?: DeviceValue;
  above?: number;
  below?: number;
  forMs?: number;
};
type EventTrigger = { kind: 'event'; device: string; endpoint: string; is?: string };
type OnlineTrigger = { kind: 'online'; device: string; is?: boolean };
type AtTrigger = { kind: 'at'; minute: number };
type EveryTrigger = { kind: 'every'; ms: number };
export type Trigger = StateTrigger | EventTrigger | OnlineTrigger | AtTrigger | EveryTrigger;

type Condition =
  | { kind: 'state'; device: string; endpoint: string; is?: DeviceValue; not?: DeviceValue; above?: number; below?: number }
  | { kind: 'online'; device: string; is: boolean };

export type Rule = {
  /** The file's name without `.yaml`. */
  name: string;
  description?: string;
  when: Trigger[];
  if: Condition[];
  then: string[];
  cooldownMs: number;
};

/** What arrived on the bus, as a rule sees it. */
export type Message =
  | { kind: 'state'; device: string; endpoint: string; value: DeviceValue }
  | { kind: 'event'; device: string; endpoint: string; value: string }
  | { kind: 'online'; device: string; online: boolean };

type Mapping = { [key: string]: unknown };

const isMapping = (value: unknown): value is Mapping => value !== null && typeof value === 'object' && !Array.isArray(value);

const target = (text: unknown, what: string): { device: string; endpoint: string } => {
  const parts = typeof text === 'string' ? text.split('/') : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`${what} takes <device>/<endpoint>, not ${JSON.stringify(text)}`);
  return { device: parts[0], endpoint: parts[1] };
};

const number = (value: unknown, what: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${what} takes a number, not ${JSON.stringify(value)}`);
  return value;
};

const scalar = (value: unknown, what: string): DeviceValue | undefined => {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  throw new Error(`${what} takes a value, not ${JSON.stringify(value)}`);
};

const duration = (value: unknown, what: string): number | undefined => {
  if (value === undefined) return undefined;
  const ms = typeof value === 'string' ? parseDuration(value) : undefined;
  if (ms === undefined) throw new Error(`${what} takes a duration such as 30s, 10m or 1h, not ${JSON.stringify(value)}`);
  return ms;
};

const only = (record: Mapping, keys: string[], what: string) => {
  const unknown = Object.keys(record).filter((key) => !keys.includes(key));
  if (unknown.length) throw new Error(`${what} has ${unknown.join(', ')}, which a rule does not read`);
};

const parseTrigger = (raw: unknown): Trigger => {
  if (!isMapping(raw)) throw new Error('a trigger is a mapping, such as "event: porch-button/input-0"');
  if ('state' in raw) {
    only(raw, ['state', 'to', 'from', 'above', 'below', 'for'], 'a state trigger');
    return {
      kind: 'state',
      ...target(raw.state, 'state'),
      to: scalar(raw.to, 'to'),
      from: scalar(raw.from, 'from'),
      above: number(raw.above, 'above'),
      below: number(raw.below, 'below'),
      forMs: duration(raw.for, 'for'),
    };
  }
  if ('event' in raw) {
    only(raw, ['event', 'is'], 'an event trigger');
    if (raw.is !== undefined && typeof raw.is !== 'string') throw new Error(`is takes a word such as single, not ${JSON.stringify(raw.is)}`);
    return { kind: 'event', ...target(raw.event, 'event'), is: raw.is as string | undefined };
  }
  if ('online' in raw) {
    only(raw, ['online', 'is'], 'an online trigger');
    if (typeof raw.online !== 'string' || !raw.online) throw new Error('online takes a device');
    if (raw.is !== undefined && typeof raw.is !== 'boolean') throw new Error('is takes true or false');
    return { kind: 'online', device: raw.online, is: raw.is as boolean | undefined };
  }
  if ('at' in raw) {
    only(raw, ['at'], 'an at trigger');
    const match = typeof raw.at === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(raw.at) : null;
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error(`at takes a time of day such as "07:30", not ${JSON.stringify(raw.at)}`);
    return { kind: 'at', minute: Number(match[1]) * 60 + Number(match[2]) };
  }
  if ('every' in raw) {
    only(raw, ['every'], 'an every trigger');
    const ms = duration(raw.every, 'every')!;
    if (ms < 60_000) throw new Error('every takes a minute or more');
    return { kind: 'every', ms };
  }
  throw new Error(`a trigger is state, event, online, at or every, not ${Object.keys(raw).join(', ') || 'nothing'}`);
};

const parseCondition = (raw: unknown): Condition => {
  if (!isMapping(raw)) throw new Error('a condition is a mapping, such as "state: hall-sensor/illuminance"');
  if ('state' in raw) {
    only(raw, ['state', 'is', 'not', 'above', 'below'], 'a state condition');
    return {
      kind: 'state',
      ...target(raw.state, 'state'),
      is: scalar(raw.is, 'is'),
      not: scalar(raw.not, 'not'),
      above: number(raw.above, 'above'),
      below: number(raw.below, 'below'),
    };
  }
  if ('online' in raw) {
    only(raw, ['online', 'is'], 'an online condition');
    if (typeof raw.online !== 'string' || !raw.online) throw new Error('online takes a device');
    return { kind: 'online', device: raw.online, is: raw.is === undefined ? true : raw.is === true };
  }
  throw new Error(`a condition is state or online, not ${Object.keys(raw).join(', ') || 'nothing'}`);
};

const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];

/** A rule from its parsed YAML, or the error that says what is wrong with it. */
export const ruleFrom = (name: string, raw: unknown): Rule => {
  if (!isMapping(raw)) throw new Error('a rule is a mapping with when and then');
  only(raw, ['description', 'when', 'if', 'then', 'cooldown'], 'the rule');
  const when = list(raw.when).map(parseTrigger);
  if (when.length === 0) throw new Error('a rule needs when: what makes it run');
  const then = list(raw.then);
  if (then.length === 0 || then.some((line) => typeof line !== 'string' || !line.trim())) throw new Error('then takes the command lines to run, one or a list');
  return {
    name,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    when,
    if: list(raw.if).map(parseCondition),
    then: then as string[],
    cooldownMs: duration(raw.cooldown, 'cooldown') ?? 0,
  };
};

/** Whether two values are the same, on and off as true and false, a number as its text. */
const same = (value: DeviceValue | undefined, wanted: DeviceValue | undefined): boolean => {
  if (value === undefined || wanted === undefined) return false;
  if (typeof value === 'boolean') {
    if (typeof wanted === 'boolean') return value === wanted;
    const word = String(wanted).toLowerCase();
    return value ? word === 'on' || word === 'true' : word === 'off' || word === 'false';
  }
  if (typeof value === 'number') return typeof wanted === 'number' ? value === wanted : Number(wanted) === value;
  return String(value) === String(wanted);
};

const numeric = (value: DeviceValue | undefined): number | undefined => typeof value === 'number' ? value : undefined;

/** Whether a value is what a state trigger waits for: all its `to`, `above` and `below` at once. */
export const holds = (trigger: { to?: DeviceValue; above?: number; below?: number }, value: DeviceValue | undefined): boolean => {
  if (trigger.to !== undefined && !same(value, trigger.to)) return false;
  const n = numeric(value);
  if (trigger.above !== undefined && !(n !== undefined && n > trigger.above)) return false;
  if (trigger.below !== undefined && !(n !== undefined && n < trigger.below)) return false;
  return true;
};

/**
 * Whether a message fires a trigger, given the endpoint's value before it. A state trigger fires
 * when its value comes to what the trigger waits for, not again while it stays there; with nothing
 * to wait for, on any change.
 */
export const fires = (trigger: Trigger, message: Message, previous: DeviceValue | undefined): boolean => {
  if (trigger.kind === 'event') {
    return message.kind === 'event' && message.device === trigger.device && message.endpoint === trigger.endpoint &&
      (trigger.is === undefined || message.value === trigger.is);
  }
  if (trigger.kind === 'online') {
    return message.kind === 'online' && message.device === trigger.device && (trigger.is === undefined || message.online === trigger.is);
  }
  if (trigger.kind !== 'state' || message.kind !== 'state' || message.device !== trigger.device || message.endpoint !== trigger.endpoint) return false;
  if (trigger.from !== undefined && !same(previous, trigger.from)) return false;
  const waits = trigger.to !== undefined || trigger.above !== undefined || trigger.below !== undefined;
  if (!waits) return previous === undefined || !same(message.value, previous);
  return holds(trigger, message.value) && !holds(trigger, previous);
};

/** Whether a condition holds, given the latest values (`<device>/<endpoint>`) and who is online. */
export const meets = (condition: Condition, values: Map<string, DeviceValue>, online: Map<string, boolean>): boolean => {
  if (condition.kind === 'online') return (online.get(condition.device) ?? false) === condition.is;
  const value = values.get(`${condition.device}/${condition.endpoint}`);
  if (value === undefined) return false;
  if (condition.is !== undefined && !same(value, condition.is)) return false;
  if (condition.not !== undefined && same(value, condition.not)) return false;
  return holds({ above: condition.above, below: condition.below }, value);
};

/** The endpoints a rule reads, as `<device>/<endpoint>`: what the engine needs the latest value of. */
export const endpointsOf = (rule: Rule): string[] => [
  ...new Set([
    ...rule.when.flatMap((trigger) => trigger.kind === 'state' ? [`${trigger.device}/${trigger.endpoint}`] : []),
    ...rule.if.flatMap((condition) => condition.kind === 'state' ? [`${condition.device}/${condition.endpoint}`] : []),
  ]),
];

const show = (value: DeviceValue | undefined): string => JSON.stringify(value);

/** A trigger as a person would write it. */
export const triggerText = (trigger: Trigger): string => {
  switch (trigger.kind) {
    case 'state': {
      const parts = [
        trigger.from !== undefined ? `from ${show(trigger.from)}` : '',
        trigger.to !== undefined ? `to ${show(trigger.to)}` : '',
        trigger.above !== undefined ? `above ${trigger.above}` : '',
        trigger.below !== undefined ? `below ${trigger.below}` : '',
        trigger.forMs ? `for ${trigger.forMs / 1000} s` : '',
      ].filter(Boolean);
      return `${trigger.device}/${trigger.endpoint} changes${parts.length ? ` ${parts.join(' ')}` : ''}`;
    }
    case 'event':
      return `${trigger.device}/${trigger.endpoint} is pressed${trigger.is ? ` (${trigger.is})` : ''}`;
    case 'online':
      return `${trigger.device} ${trigger.is === false ? 'goes offline' : trigger.is === true ? 'comes online' : 'comes or goes'}`;
    case 'at':
      return `at ${String(Math.floor(trigger.minute / 60)).padStart(2, '0')}:${String(trigger.minute % 60).padStart(2, '0')}`;
    case 'every':
      return `every ${trigger.ms / 60_000} min`;
  }
};

/** A condition as a person would write it. */
export const conditionText = (condition: Condition): string => {
  if (condition.kind === 'online') return `${condition.device} is ${condition.is ? 'online' : 'offline'}`;
  const parts = [
    condition.is !== undefined ? `is ${show(condition.is)}` : '',
    condition.not !== undefined ? `is not ${show(condition.not)}` : '',
    condition.above !== undefined ? `above ${condition.above}` : '',
    condition.below !== undefined ? `below ${condition.below}` : '',
  ].filter(Boolean);
  return `${condition.device}/${condition.endpoint} ${parts.join(' ') || 'has a value'}`;
};
