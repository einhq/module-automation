/**
 * Shelly's second generation and later (Plus, Pro, Gen3, Gen4), over MQTT. Each device has a topic
 * prefix, by default its id (`shellyplus1pm-a8032ab12345`), and with "generic status update over
 * MQTT" and "RPC status notifications over MQTT" on it says:
 *
 *   <prefix>/online                  true or false
 *   <prefix>/status/<component>      the component's whole status, as JSON (`switch:0`, `sys`)
 *   <prefix>/events/rpc              NotifyStatus (changes), NotifyFullStatus, NotifyEvent (presses)
 *
 * and takes JSON-RPC on `<prefix>/rpc`, answering on `<src>/rpc`. A prefix becomes a device the
 * first time it says something only a Shelly says; the bridge then asks it what it is
 * (`Shelly.GetDeviceInfo`) and for its whole status (`Shelly.GetStatus`).
 *
 * The device is named by its prefix, an entity by its component and field: `switch-0` (the relay),
 * `switch-0-power`, `input-0`, `temperature-0`.
 */

import { deviceName, type DeviceValue } from '@ein/api';
import { labelOf } from './label.ts';
import type { EntityKind, MqttSource, Publish, Update } from './types.ts';

/** One field of a component's status that is an entity. */
type Field = {
  /** Appended to the component's name: `switch-0` + `-power`. Empty for the component itself. */
  suffix: string;
  path: string[];
  kind: EntityKind;
  unit?: string;
  deviceClass?: string;
  label?: string;
  /** Tells of the device itself, not of the house. */
  diagnostic?: true;
};

const POWER: Field[] = [
  { suffix: '-power', path: ['apower'], kind: 'sensor', unit: 'W', deviceClass: 'power', label: 'power' },
  { suffix: '-voltage', path: ['voltage'], kind: 'sensor', unit: 'V', deviceClass: 'voltage', label: 'voltage' },
  { suffix: '-current', path: ['current'], kind: 'sensor', unit: 'A', deviceClass: 'current', label: 'current' },
  { suffix: '-energy', path: ['aenergy', 'total'], kind: 'sensor', unit: 'Wh', deviceClass: 'energy', label: 'energy' },
  { suffix: '-temperature', path: ['temperature', 'tC'], kind: 'sensor', unit: '°C', deviceClass: 'temperature', label: 'temperature', diagnostic: true },
];

/** What each component type's status holds that is worth an entity. */
const COMPONENTS: Record<string, Field[]> = {
  switch: [{ suffix: '', path: ['output'], kind: 'switch', deviceClass: 'outlet' }, ...POWER],
  light: [
    { suffix: '', path: ['output'], kind: 'light' },
    { suffix: '-brightness', path: ['brightness'], kind: 'sensor', unit: '%', label: 'brightness' },
    ...POWER,
  ],
  pm1: POWER,
  cover: [
    { suffix: '-position', path: ['current_pos'], kind: 'sensor', unit: '%', label: 'position' },
    { suffix: '-state', path: ['state'], kind: 'sensor', label: 'state' },
    ...POWER,
  ],
  em1: [
    { suffix: '-power', path: ['act_power'], kind: 'sensor', unit: 'W', deviceClass: 'power', label: 'power' },
    { suffix: '-voltage', path: ['voltage'], kind: 'sensor', unit: 'V', deviceClass: 'voltage', label: 'voltage' },
    { suffix: '-current', path: ['current'], kind: 'sensor', unit: 'A', deviceClass: 'current', label: 'current' },
  ],
  em: [{ suffix: '-power', path: ['total_act_power'], kind: 'sensor', unit: 'W', deviceClass: 'power', label: 'power' }],
  temperature: [{ suffix: '', path: ['tC'], kind: 'sensor', unit: '°C', deviceClass: 'temperature' }],
  humidity: [{ suffix: '', path: ['rh'], kind: 'sensor', unit: '%', deviceClass: 'humidity' }],
  illuminance: [{ suffix: '', path: ['lux'], kind: 'sensor', unit: 'lx', deviceClass: 'illuminance' }],
  voltmeter: [{ suffix: '', path: ['voltage'], kind: 'sensor', unit: 'V', deviceClass: 'voltage' }],
  devicepower: [{ suffix: '-battery', path: ['battery', 'percent'], kind: 'sensor', unit: '%', deviceClass: 'battery', label: 'battery' }],
  wifi: [{ suffix: '-rssi', path: ['rssi'], kind: 'sensor', unit: 'dBm', deviceClass: 'signal_strength', label: 'wifi signal', diagnostic: true }],
};

/** What NotifyEvent calls a press, and the word an entity's events say. */
const PRESSES: Record<string, string> = {
  single_push: 'single',
  double_push: 'double',
  triple_push: 'triple',
  long_push: 'long',
};

const COMPONENT = /^([a-z0-9_]+)(?::(\d+))?$/;
const SETTABLE: Record<string, string> = { switch: 'Switch', light: 'Light' };

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);

const at = (status: Json, path: string[]): unknown => {
  let value: unknown = status;
  for (const step of path) {
    if (!isObject(value)) return undefined;
    value = value[step];
  }
  return value;
};

const asValue = (raw: unknown): DeviceValue | undefined => {
  if (raw === null) return null;
  if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'string') return raw;
  return undefined;
};

type ShellyOptions = {
  /** Our own name in JSON-RPC (`src`): answers come on `<src>/rpc`. */
  src: string;
};

export const createShelly = (options: ShellyOptions): MqttSource => {
  const src = options.src;
  /** Device name by prefix, for the prefixes known to be Shellies. */
  const prefixes = new Map<string, string>();
  const devices = new Map<string, string>();
  /** Entities announced, by `<device>/<entity>`, with their kind. */
  const entities = new Map<string, EntityKind>();
  /** What each outstanding request of ours asked, by its id. */
  const pending = new Map<number, { prefix: string; method: string }>();
  let nextId = 1;

  const request = (prefix: string, method: string, params?: Json): Update => {
    const id = nextId++;
    pending.set(id, { prefix, method });
    return { kind: 'publish', publish: { topic: `${prefix}/rpc`, payload: JSON.stringify({ id, src, method, ...(params ? { params } : {}) }) } };
  };

  /** The device of a prefix, made known (and asked about itself) the first time. */
  const deviceOf = (prefix: string, updates: Update[]): string | undefined => {
    const known = prefixes.get(prefix);
    if (known) return known;
    const device = deviceName(prefix);
    if (!device) return undefined;
    prefixes.set(prefix, device);
    devices.set(device, prefix);
    updates.push(
      { kind: 'device', device, label: prefix },
      request(prefix, 'Shelly.GetDeviceInfo'),
      request(prefix, 'Shelly.GetStatus'),
    );
    return device;
  };

  /** The entities a component's status names, announced when new, and their values. */
  const statusUpdates = (device: string, key: string, status: Json, retained: boolean): Update[] => {
    const match = COMPONENT.exec(key);
    if (!match) return [];
    const [, type, index] = match;
    const fields = type === 'input' ? [{ suffix: '', path: ['state'], kind: (status.state === null ? 'button' : 'binary') as EntityKind }] : COMPONENTS[type];
    if (!fields) return [];
    const name = index === undefined ? deviceName(type) : `${deviceName(type)}-${index}`;
    const updates: Update[] = [];
    for (const field of fields) {
      const raw = at(status, field.path);
      if (raw === undefined) continue;
      const entity = `${name}${field.suffix}`;
      if (!entities.has(`${device}/${entity}`)) {
        entities.set(`${device}/${entity}`, field.kind);
        updates.push({
          kind: 'entity',
          device,
          entity,
          label: labelOf(field.label ? `${name} ${field.label}` : name),
          entityKind: field.kind,
          unit: field.unit,
          deviceClass: field.deviceClass,
          ...(field.diagnostic ? { category: 'diagnostic' as const } : {}),
          settable: field.suffix === '' && type in SETTABLE,
          supported: true,
        });
      }
      if (field.kind === 'button') continue;
      const value = asValue(raw);
      if (value !== undefined) updates.push({ kind: 'state', device, entity, value, retained });
    }
    return updates;
  };

  const sysUpdates = (device: string, prefix: string, sys: Json): Update[] =>
    typeof sys.mac === 'string' ? [{ kind: 'device', device, label: prefix, mac: sys.mac.toLowerCase() }] : [];

  const notify = (prefix: string, message: Json, retained: boolean): Update[] => {
    const updates: Update[] = [];
    const device = deviceOf(prefix, updates);
    if (!device) return [];
    const params = isObject(message.params) ? message.params : {};
    if (message.method === 'NotifyStatus' || message.method === 'NotifyFullStatus') {
      for (const [key, status] of Object.entries(params)) {
        if (!isObject(status)) continue;
        if (key === 'sys') updates.push(...sysUpdates(device, prefix, status));
        updates.push(...statusUpdates(device, key, status, retained));
      }
    } else if (message.method === 'NotifyEvent' && !retained) {
      for (const event of Array.isArray(params.events) ? params.events : []) {
        if (!isObject(event) || typeof event.component !== 'string' || typeof event.event !== 'string') continue;
        const press = PRESSES[event.event];
        const match = COMPONENT.exec(event.component);
        if (!press || !match || match[1] !== 'input') continue;
        const entity = `input-${match[2] ?? 0}`;
        if (entities.get(`${device}/${entity}`) !== 'button') {
          entities.set(`${device}/${entity}`, 'button');
          updates.push({ kind: 'entity', device, entity, label: labelOf(entity), entityKind: 'button', settable: false, supported: true });
        }
        updates.push({ kind: 'event', device, entity, value: press });
      }
    }
    return updates;
  };

  /** An answer to one of our requests. */
  const answer = (message: Json): Update[] => {
    const asked = typeof message.id === 'number' ? pending.get(message.id) : undefined;
    if (!asked || !isObject(message.result)) return [];
    pending.delete(message.id as number);
    const device = prefixes.get(asked.prefix);
    if (!device) return [];
    const result = message.result;
    if (asked.method === 'Shelly.GetDeviceInfo') {
      return [{
        kind: 'device',
        device,
        label: typeof result.name === 'string' && result.name ? result.name : asked.prefix,
        manufacturer: 'Shelly',
        model: typeof result.model === 'string' ? result.model : undefined,
        firmware: typeof result.ver === 'string' ? result.ver : undefined,
        mac: typeof result.mac === 'string' ? result.mac.toLowerCase() : undefined,
      }];
    }
    if (asked.method === 'Shelly.GetStatus') {
      return Object.entries(result).flatMap(([key, status]) => isObject(status) ? statusUpdates(device, key, status, false) : []);
    }
    return [];
  };

  const parse = (payload: string): Json | undefined => {
    try {
      const parsed = JSON.parse(payload);
      return isObject(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    name: 'shelly',
    description: "Shelly's second generation and later (Plus, Pro, Gen3, Gen4), over MQTT",
    topics: () => ['+/online', '+/status/+', '+/events/rpc', `${src}/rpc`],
    forget(device) {
      const prefix = devices.get(device);
      if (prefix) prefixes.delete(prefix);
      devices.delete(device);
      for (const key of [...entities.keys()]) if (key.startsWith(`${device}/`)) entities.delete(key);
      return [];
    },
    decode(topic, payload, retained) {
      if (topic === `${src}/rpc`) {
        const message = parse(payload);
        return message ? answer(message) : [];
      }
      const parts = topic.split('/');
      if (parts.length === 2 && parts[1] === 'online') {
        const text = payload.trim();
        if (text !== 'true' && text !== 'false') return [];
        const updates: Update[] = [];
        const device = deviceOf(parts[0], updates);
        return device ? [...updates, { kind: 'online', device, online: text === 'true' }] : [];
      }
      const type = parts.length === 3 && parts[1] === 'status' ? COMPONENT.exec(parts[2])?.[1] : undefined;
      if (type) {
        const status = parse(payload);
        // Only what a Shelly says makes a prefix a device: a component read here, or `sys` with its MAC.
        if (!status || !(type in COMPONENTS || type === 'input' || (type === 'sys' && typeof status.mac === 'string'))) return [];
        const updates: Update[] = [];
        const device = deviceOf(parts[0], updates);
        if (!device) return [];
        if (parts[2] === 'sys') updates.push(...sysUpdates(device, parts[0], status));
        return [...updates, ...statusUpdates(device, parts[2], status, retained)];
      }
      if (parts.length === 3 && parts[1] === 'events' && parts[2] === 'rpc') {
        const message = parse(payload);
        return message && typeof message.method === 'string' ? notify(parts[0], message, retained) : [];
      }
      return [];
    },
    encode({ device, entity, value }) {
      const prefix = devices.get(device);
      const match = /^(switch|light)-(\d+)$/.exec(entity);
      if (!prefix || !match) return undefined;
      const call = { id: nextId++, src, method: `${SETTABLE[match[1]]}.Set`, params: { id: Number(match[2]), on: value === 'on' } };
      return [{ topic: `${prefix}/rpc`, payload: JSON.stringify(call) } satisfies Publish];
    },
  };
};
