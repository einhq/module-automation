/**
 * Shelly's first generation (Plug S, 1, 1PM, 2.5, i3, Dimmer, Bulb, RGBW2, …), over MQTT. With MQTT
 * on, which a Shelly of this generation takes at its next restart, a device says, under
 * `shellies/<id>` with its id `<model>-<mac>` (`shellyplug-s-a1b2c3d4e5f6`):
 *
 *   shellies/<id>/announce, shellies/announce   what it is ({id, model, mac, fw_ver}), on connecting
 *   shellies/<id>/online                         true, or false as its last will
 *   shellies/<id>/relay/<n>                      on or off
 *   shellies/<id>/relay/<n>/power                the power drawn, W
 *   shellies/<id>/relay/<n>/energy               the energy drawn since it last started, watt-minutes
 *   shellies/<id>/light/<n>                      a light, on or off (also color/<n> and white/<n>)
 *   shellies/<id>/light/<n>/status               its mode, brightness, colour and temperature, as JSON
 *   shellies/<id>/roller/<n>                     a roller's state: open, close or stop
 *   shellies/<id>/roller/<n>/pos                 where it is, 0–100 %, or -1 when it does not know
 *   shellies/<id>/temperature                    its own temperature, °C
 *   shellies/<id>/input_event/<n>                a button's press ({"event": "S"}: S, SS, SSS, L, SL, LS)
 *
 * and takes `on` and `off` on `relay/<n>/command` and `light/<n>/command`, a light's brightness,
 * colour and temperature as JSON on `light/<n>/set`, and `open`, `close`, `stop` on
 * `roller/<n>/command` and a position on `roller/<n>/command/pos`. A device heard before it
 * announced itself is asked to (`shellies/<id>/command` `announce`), which a bridge that started
 * after it did needs, since a device announces only when it connects.
 *
 * The device is named by its id; an entity by what it is: `relay-0`, `relay-0-power`,
 * `relay-0-energy`, `light-0`, `light-0-brightness`, `color-0-color`, `roller-0-position`,
 * `roller-0-open`, `temperature`, `input-0`.
 */

import { deviceName, type DeviceValue } from '@ein/api';
import { hexOf, rgbOf } from './color.ts';
import { labelOf } from './label.ts';
import type { EntityUpdate, MqttSource, Publish, Update } from './types.ts';

/** What a first generation Shelly's model code is sold as. */
const MODELS: Record<string, string> = {
  'SHPLG-S': 'Plug S',
  'SHPLG-1': 'Plug',
  'SHPLG2-1': 'Plug',
  'SHPLG-U1': 'Plug US',
  'SHSW-1': '1',
  'SHSW-PM': '1PM',
  'SHSW-L': '1L',
  'SHSW-25': '2.5',
  'SHIX3-1': 'i3',
  'SHDM-1': 'Dimmer',
  'SHDM-2': 'Dimmer 2',
  'SHBLB-1': 'Bulb',
  'SHCB-1': 'Duo RGBW',
  'SHBDUO-1': 'Duo',
  'SHVIN-1': 'Vintage',
  'SHRGBW2': 'RGBW2',
  'SHEM': 'EM',
};

/** A press as a Shelly codes it, in the words an automation says: `S` is `single`. */
const PRESSES: Record<string, string> = { S: 'single', SS: 'double', SSS: 'triple', L: 'long', SL: 'single-long', LS: 'long-single' };

const WATT_MINUTES_PER_WH = 60;

type Reading = Omit<EntityUpdate, 'kind' | 'device' | 'entity' | 'settable' | 'supported'> & {
  settable?: boolean;
  /** Its state from the payload; none for an action, which has no state. */
  value?: (payload: string) => DeviceValue | undefined;
};

type Found = { entity: string; reading: Reading };

const number = (payload: string): number | undefined => {
  const value = Number(payload.trim());
  return payload.trim() !== '' && Number.isFinite(value) ? value : undefined;
};

const onOff = (payload: string): boolean | undefined => payload.trim() === 'on' ? true : payload.trim() === 'off' ? false : undefined;

/** A field of a JSON status, when it is a number. */
const field = (name: string) => (payload: string): number | undefined => {
  const value = parse(payload)?.[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

/** The parts a light is said under: `light` (Dimmer, Duo, Vintage), `color` and `white` (Bulb, Duo RGBW, RGBW2). */
const LIGHTS = new Set(['light', 'color', 'white']);

/**
 * Which field is a light's brightness: in colour mode its gain, in white mode its brightness, and
 * when it does not say its mode, the gain of a `color` light (an RGBW2) and the brightness of another.
 */
const brightnessField = (part: string, mode: unknown): 'gain' | 'brightness' =>
  mode === 'color' ? 'gain' : mode === 'white' ? 'brightness' : part === 'color' ? 'gain' : 'brightness';

/** What a light's JSON status (`light/0/status`, `color/0/status`) holds, each with what it reads. */
const lightReadings = (part: string, light: string): Found[] => [
  {
    entity: `${light}-brightness`,
    reading: {
      label: labelOf(`${light} brightness`),
      entityKind: 'number',
      unit: '%',
      min: 0,
      max: 100,
      step: 1,
      settable: true,
      value: (p) => {
        const status = parse(p);
        const value = status ? status[brightnessField(part, status.mode)] : undefined;
        return typeof value === 'number' ? value : undefined;
      },
    },
  },
  {
    entity: `${light}-color`,
    reading: {
      label: labelOf(`${light} colour`),
      entityKind: 'color',
      settable: true,
      value: (p) => {
        const status = parse(p);
        return status ? hexOf(status.red, status.green, status.blue) : undefined;
      },
    },
  },
  ...(part === 'color'
    ? [{
      entity: `${light}-white`,
      reading: { label: labelOf(`${light} white`), entityKind: 'number' as const, min: 0, max: 255, step: 1, settable: true, value: field('white') },
    }]
    : []),
  {
    entity: `${light}-color-temperature`,
    reading: { label: labelOf(`${light} colour temperature`), entityKind: 'number', unit: 'K', step: 1, settable: true, value: field('temp') },
  },
];

/** What each topic under `shellies/<id>/` is, by its path there: `relay/0/power` → the relay's power. */
const readingsOf = (rest: string[]): Found[] => {
  if (rest[0] === 'relay' && /^\d+$/.test(rest[1] ?? '')) {
    const relay = `relay-${rest[1]}`;
    if (rest.length === 2) {
      return [{ entity: relay, reading: { label: labelOf(relay), entityKind: 'switch', deviceClass: 'outlet', settable: true, value: onOff } }];
    }
    if (rest.length === 3 && rest[2] === 'power') {
      return [{ entity: `${relay}-power`, reading: { label: labelOf(`${relay} power`), entityKind: 'sensor', unit: 'W', deviceClass: 'power', value: number } }];
    }
    if (rest.length === 3 && rest[2] === 'energy') {
      return [{
        entity: `${relay}-energy`,
        reading: {
          label: labelOf(`${relay} energy since start`),
          entityKind: 'sensor',
          unit: 'Wh',
          deviceClass: 'energy',
          value: (p) => {
            const minutes = number(p);
            return minutes === undefined ? undefined : Math.round(minutes / WATT_MINUTES_PER_WH * 100) / 100;
          },
        },
      }];
    }
    return [];
  }
  if (LIGHTS.has(rest[0]) && /^\d+$/.test(rest[1] ?? '')) {
    const light = `${rest[0]}-${rest[1]}`;
    if (rest.length === 2) return [{ entity: light, reading: { label: labelOf(light), entityKind: 'light', settable: true, value: onOff } }];
    if (rest.length === 3 && rest[2] === 'status') return lightReadings(rest[0], light);
    return [];
  }
  if (rest[0] === 'roller' && /^\d+$/.test(rest[1] ?? '')) {
    const roller = `roller-${rest[1]}`;
    if (rest.length === 2) {
      const action = (move: string): Found => ({ entity: `${roller}-${move}`, reading: { label: labelOf(`${roller} ${move}`), entityKind: 'action', settable: true } });
      return [
        { entity: `${roller}-state`, reading: { label: labelOf(`${roller} state`), entityKind: 'sensor', value: (p) => p.trim() || undefined } },
        action('open'),
        action('close'),
        action('stop'),
      ];
    }
    if (rest.length === 3 && rest[2] === 'pos') {
      return [{
        entity: `${roller}-position`,
        reading: {
          label: labelOf(`${roller} position`),
          entityKind: 'number',
          unit: '%',
          min: 0,
          max: 100,
          step: 1,
          settable: true,
          // An uncalibrated roller says -1: it does not know where it is.
          value: (p) => {
            const position = number(p);
            return position === undefined ? undefined : position < 0 ? null : position;
          },
        },
      }];
    }
    return [];
  }
  if (rest.length === 1 && rest[0] === 'temperature') {
    return [{ entity: 'temperature', reading: { label: 'Temperature', entityKind: 'sensor', unit: '°C', deviceClass: 'temperature', category: 'diagnostic', value: number } }];
  }
  return [];
};

/** What to send for a command to one entity of the device with this id, by the entity's name. */
const commandOf = (id: string, entity: string, value: string, mode: string | undefined): Publish | undefined => {
  const base = `shellies/${id}`;
  const relay = /^relay-(\d+)$/.exec(entity);
  if (relay) return value === 'on' || value === 'off' ? { topic: `${base}/relay/${relay[1]}/command`, payload: value } : undefined;
  const roller = /^roller-(\d+)-(position|open|close|stop)$/.exec(entity);
  if (roller) {
    if (roller[2] !== 'position') return { topic: `${base}/roller/${roller[1]}/command`, payload: roller[2] };
    const position = number(value);
    return position === undefined ? undefined : { topic: `${base}/roller/${roller[1]}/command/pos`, payload: String(Math.round(position)) };
  }
  const light = /^(light|color|white)-(\d+)(?:-(brightness|color|white|color-temperature))?$/.exec(entity);
  if (!light) return undefined;
  const [, part, index, what] = light;
  if (!what) return value === 'on' || value === 'off' ? { topic: `${base}/${part}/${index}/command`, payload: value } : undefined;
  // A light that says its mode is told it with each setting: a Duo RGBW ignores a setting of one
  // field alone. A colour is set in colour mode, a temperature in white.
  const set = (params: Record<string, unknown>): Publish => ({
    topic: `${base}/${part}/${index}/set`,
    payload: JSON.stringify(mode && !('mode' in params) ? { mode, ...params } : params),
  });
  if (what === 'color') {
    const rgb = rgbOf(value);
    return rgb ? set({ mode: 'color', red: rgb[0], green: rgb[1], blue: rgb[2] }) : undefined;
  }
  const amount = number(value);
  if (amount === undefined) return undefined;
  if (what === 'brightness') return set({ [brightnessField(part, mode)]: amount });
  return set(what === 'white' ? { white: amount } : { mode: 'white', temp: amount });
};

/** The JSON object in a payload, or undefined. */
const parse = (payload: string): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(payload);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
};

export const createShellyGen1 = (): MqttSource => {
  /** Device name by id, for the ids heard. */
  const devices = new Map<string, string>();
  /** The ids that announced themselves; the rest have been asked to. */
  const announced = new Set<string>();
  /** Entities announced, by `<device>/<entity>`. */
  const entities = new Set<string>();
  /** The mode each light last said it is in (`color`, `white`), by `<id>/<light>`. */
  const modes = new Map<string, string>();

  /** The device of an id, made with what is known of it so far, and asked what it is if it has not said. */
  const deviceOf = (id: string, updates: Update[]): string => {
    let device = devices.get(id);
    if (!device) {
      device = deviceName(id);
      devices.set(id, device);
      updates.push({ kind: 'device', device, label: id, manufacturer: 'Shelly' });
    }
    if (!announced.has(id)) {
      announced.add(id);
      updates.push({ kind: 'publish', publish: { topic: `shellies/${id}/command`, payload: 'announce' } });
    }
    return device;
  };

  const announce = (info: Record<string, unknown>): Update[] => {
    const id = typeof info.id === 'string' ? info.id : undefined;
    if (!id || !/^[\w-]+$/.test(id)) return [];
    const updates: Update[] = [];
    const device = devices.get(id) ?? deviceName(id);
    devices.set(id, device);
    announced.add(id);
    const model = typeof info.model === 'string' ? info.model : undefined;
    updates.push({
      kind: 'device',
      device,
      label: id,
      manufacturer: 'Shelly',
      ...(model ? { model: MODELS[model] ?? model } : {}),
      ...(typeof info.fw_ver === 'string' ? { firmware: info.fw_ver } : {}),
      ...(typeof info.mac === 'string' ? { mac: info.mac.toLowerCase().match(/.{2}/g)!.join(':') } : {}),
      ...(typeof info.ip === 'string' && info.ip ? { url: `http://${info.ip}/` } : {}),
    });
    return updates;
  };

  return {
    name: 'shelly-gen1',
    description: "Shelly's first generation (Plug S, 1, 1PM, 2.5, i3, Dimmer, Bulb, RGBW2, …), over MQTT",
    topics: () => [
      'shellies/announce',
      'shellies/+/announce',
      'shellies/+/online',
      'shellies/+/relay/#',
      'shellies/+/light/#',
      'shellies/+/color/#',
      'shellies/+/white/#',
      'shellies/+/roller/#',
      'shellies/+/temperature',
      'shellies/+/input_event/+',
    ],
    forget(device) {
      for (const [id, name] of devices) {
        if (name !== device) continue;
        devices.delete(id);
        announced.delete(id);
        for (const key of [...modes.keys()]) if (key.startsWith(`${id}/`)) modes.delete(key);
      }
      for (const key of [...entities]) if (key.startsWith(`${device}/`)) entities.delete(key);
      return [];
    },
    decode(topic, payload, retained) {
      const parts = topic.split('/');
      if (parts[0] !== 'shellies' || parts.length < 2) return [];
      if (parts.length === 2 && parts[1] === 'announce') {
        const info = parse(payload);
        return info ? announce(info) : [];
      }
      const id = parts[1];
      if (!/^[\w-]+$/.test(id) || id === 'command') return [];
      const rest = parts.slice(2);
      if (rest.length === 1 && rest[0] === 'announce') {
        const info = parse(payload);
        return info ? announce({ ...info, id: info.id ?? id }) : [];
      }
      if (rest.length === 1 && rest[0] === 'online') {
        const text = payload.trim();
        if (text !== 'true' && text !== 'false') return [];
        const updates: Update[] = [];
        const device = deviceOf(id, updates);
        return [...updates, { kind: 'online', device, online: text === 'true' }];
      }
      if (rest.length === 2 && rest[0] === 'input_event' && /^\d+$/.test(rest[1])) {
        const event = parse(payload)?.event;
        if (typeof event !== 'string' || event === '') return [];
        const updates: Update[] = [];
        const device = deviceOf(id, updates);
        const entity = `input-${rest[1]}`;
        if (!entities.has(`${device}/${entity}`)) {
          entities.add(`${device}/${entity}`);
          updates.push({ kind: 'entity', device, entity, label: labelOf(entity), entityKind: 'button', settable: false, supported: true });
        }
        // A retained press is one that happened before the bridge heard it: not news.
        if (!retained) updates.push({ kind: 'event', device, entity, value: PRESSES[event] ?? event.toLowerCase() });
        return updates;
      }
      const readings = readingsOf(rest).map((found) => ({ ...found, value: found.reading.value?.(payload) }))
        .filter((found) => found.value !== undefined || !found.reading.value);
      if (!readings.some((found) => found.value !== undefined)) return [];
      if (rest[2] === 'status' && typeof parse(payload)?.mode === 'string') modes.set(`${id}/${rest[0]}-${rest[1]}`, parse(payload)!.mode as string);
      const updates: Update[] = [];
      const device = deviceOf(id, updates);
      for (const found of readings) {
        if (!entities.has(`${device}/${found.entity}`)) {
          entities.add(`${device}/${found.entity}`);
          const { value: _value, settable, ...about } = found.reading;
          updates.push({ kind: 'entity', device, entity: found.entity, ...about, settable: settable === true, supported: true });
        }
        if (found.value !== undefined) updates.push({ kind: 'state', device, entity: found.entity, value: found.value, retained });
      }
      return updates;
    },
    encode({ device, entity, value }) {
      const id = [...devices].find(([, name]) => name === device)?.[0];
      const light = /^((?:light|color|white)-\d+)/.exec(entity)?.[1];
      const publish = id ? commandOf(id, entity, value, light ? modes.get(`${id}/${light}`) : undefined) : undefined;
      return publish ? [publish] : undefined;
    },
  };
};
