/**
 * Shelly's first generation (Plug S, 1, 1PM, 2.5, i3, …), over MQTT. With MQTT on, which a Shelly of
 * this generation takes at its next restart, a device says, under `shellies/<id>` with its id
 * `<model>-<mac>` (`shellyplug-s-a1b2c3d4e5f6`):
 *
 *   shellies/<id>/announce, shellies/announce   what it is ({id, model, mac, fw_ver}), on connecting
 *   shellies/<id>/online                         true, or false as its last will
 *   shellies/<id>/relay/<n>                      on or off
 *   shellies/<id>/relay/<n>/power                the power drawn, W
 *   shellies/<id>/relay/<n>/energy               the energy drawn since it last started, watt-minutes
 *   shellies/<id>/temperature                    its own temperature, °C
 *   shellies/<id>/input_event/<n>                a button's press ({"event": "S"}: S, SS, SSS, L, SL, LS)
 *
 * and takes `on` and `off` on `shellies/<id>/relay/<n>/command`. A device heard before it announced
 * itself is asked to (`shellies/<id>/command` `announce`), which a bridge that started after it did
 * needs, since a device announces only when it connects.
 *
 * The device is named by its id; an entity by what it is: `relay-0`, `relay-0-power`,
 * `relay-0-energy`, `temperature`, `input-0`.
 */

import { deviceName, type DeviceValue } from '@ein/api';
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
  'SHEM': 'EM',
};

/** A press as a Shelly codes it, in the words a rule says: `S` is `single`. */
const PRESSES: Record<string, string> = { S: 'single', SS: 'double', SSS: 'triple', L: 'long', SL: 'single-long', LS: 'long-single' };

const WATT_MINUTES_PER_WH = 60;

type Reading = Omit<EntityUpdate, 'kind' | 'device' | 'entity' | 'settable' | 'supported'> & { settable?: boolean; value: (payload: string) => DeviceValue | undefined };

const number = (payload: string): number | undefined => {
  const value = Number(payload.trim());
  return payload.trim() !== '' && Number.isFinite(value) ? value : undefined;
};

/** What each topic under `shellies/<id>/` is, by its path there: `relay/0/power` → the relay's power. */
const readingOf = (rest: string[]): { entity: string; reading: Reading } | undefined => {
  if (rest[0] === 'relay' && /^\d+$/.test(rest[1] ?? '')) {
    const relay = `relay-${rest[1]}`;
    if (rest.length === 2) {
      return {
        entity: relay,
        reading: {
          label: labelOf(relay),
          entityKind: 'switch',
          deviceClass: 'outlet',
          settable: true,
          value: (p) => p.trim() === 'on' ? true : p.trim() === 'off' ? false : undefined,
        },
      };
    }
    if (rest.length === 3 && rest[2] === 'power') {
      return { entity: `${relay}-power`, reading: { label: labelOf(`${relay} power`), entityKind: 'sensor', unit: 'W', deviceClass: 'power', value: number } };
    }
    if (rest.length === 3 && rest[2] === 'energy') {
      return {
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
      };
    }
    return undefined;
  }
  if (rest.length === 1 && rest[0] === 'temperature') {
    return { entity: 'temperature', reading: { label: 'Temperature', entityKind: 'sensor', unit: '°C', deviceClass: 'temperature', category: 'diagnostic', value: number } };
  }
  return undefined;
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
    });
    return updates;
  };

  return {
    name: 'shelly-gen1',
    description: "Shelly's first generation (Plug S, 1, 1PM, 2.5, i3, …), over MQTT",
    topics: () => ['shellies/announce', 'shellies/+/announce', 'shellies/+/online', 'shellies/+/relay/#', 'shellies/+/temperature', 'shellies/+/input_event/+'],
    forget(device) {
      for (const [id, name] of devices) {
        if (name !== device) continue;
        devices.delete(id);
        announced.delete(id);
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
      const found = readingOf(rest);
      if (!found) return [];
      const value = found.reading.value(payload);
      if (value === undefined) return [];
      const updates: Update[] = [];
      const device = deviceOf(id, updates);
      if (!entities.has(`${device}/${found.entity}`)) {
        entities.add(`${device}/${found.entity}`);
        const { value: _value, settable, ...about } = found.reading;
        updates.push({ kind: 'entity', device, entity: found.entity, ...about, settable: settable === true, supported: true });
      }
      return [...updates, { kind: 'state', device, entity: found.entity, value, retained }];
    },
    encode({ device, entity, value }) {
      const id = [...devices].find(([, name]) => name === device)?.[0];
      const match = /^relay-(\d+)$/.exec(entity);
      if (!id || !match || (value !== 'on' && value !== 'off')) return undefined;
      return [{ topic: `shellies/${id}/relay/${match[1]}/command`, payload: value } satisfies Publish];
    },
  };
};
