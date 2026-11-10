/**
 * Home Assistant's MQTT discovery: a device announces each of its entities as a retained JSON
 * message on `<prefix>/<component>/[<node_id>/]<object_id>/config`, naming the topics its state
 * comes on and its commands go to. ESPHome announces this way when it has an `mqtt:` block, and
 * so do Zigbee2MQTT and others.
 *
 * The device is named by its node id (ESPHome's own name for it), else by its first identifier;
 * the entity by its object id. An empty config message withdraws the entity.
 *
 * Read: `sensor`, `binary_sensor`, `switch`, `light`, `number`, `select`, `text`, `button`, `event`
 * and `device_automation` triggers. Other components are skipped and listed by `notes()`.
 *
 * A light, of either schema, is on and off; its brightness is `<light>-brightness`, in %, and its
 * colour `<light>-color`, as `#rrggbb`, when it has them. The JSON schema's colour is read from r, g
 * and b, hue and saturation, or x and y, and set in the light's own colour mode.
 */

import { deviceName, type DeviceValue } from '@ein/api';
import { hexOf, hexOfHs, hexOfXy, hsOf, type Rgb, rgbOf, xyOf } from './color.ts';
import { labelOf } from './label.ts';
import { compileTemplate, type Template } from './template.ts';
import type { Command, EntityKind, EntityUpdate, MqttSource, Publish, Update } from './types.ts';

/** Home Assistant's abbreviations of the keys this source reads. */
const ABBREVIATIONS: Record<string, string> = {
  atype: 'automation_type',
  avty: 'availability',
  avty_mode: 'availability_mode',
  avty_t: 'availability_topic',
  bri_cmd_t: 'brightness_command_topic',
  bri_cmd_tpl: 'brightness_command_template',
  bri_scl: 'brightness_scale',
  bri_stat_t: 'brightness_state_topic',
  bri_val_tpl: 'brightness_value_template',
  clrm: 'color_mode',
  cmd_t: 'command_topic',
  cns: 'connections',
  cu: 'configuration_url',
  dev: 'device',
  dev_cla: 'device_class',
  ent_cat: 'entity_category',
  evt_typ: 'event_types',
  hw: 'hw_version',
  ids: 'identifiers',
  mdl: 'model',
  mf: 'manufacturer',
  obj_id: 'object_id',
  ops: 'options',
  pl: 'payload',
  pl_avail: 'payload_available',
  pl_not_avail: 'payload_not_available',
  pl_off: 'payload_off',
  pl_on: 'payload_on',
  pl_prs: 'payload_press',
  rgb_cmd_t: 'rgb_command_topic',
  rgb_cmd_tpl: 'rgb_command_template',
  rgb_stat_t: 'rgb_state_topic',
  rgb_val_tpl: 'rgb_value_template',
  stat_cla: 'state_class',
  stat_off: 'state_off',
  stat_on: 'state_on',
  stat_t: 'state_topic',
  stat_val_tpl: 'state_value_template',
  stype: 'subtype',
  sup_clrm: 'supported_color_modes',
  sw: 'sw_version',
  t: 'topic',
  uniq_id: 'unique_id',
  unit_of_meas: 'unit_of_measurement',
  val_tpl: 'value_template',
};

const KINDS: Record<string, EntityKind> = {
  sensor: 'sensor',
  binary_sensor: 'binary',
  switch: 'switch',
  light: 'light',
  number: 'number',
  select: 'text',
  text: 'text',
  button: 'action',
  event: 'button',
  device_automation: 'button',
};

type Config = Record<string, unknown>;

const expand = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(expand);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [ABBREVIATIONS[key] ?? key, expand(inner)]));
};

const str = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined;
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** `~` at either end of a topic stands for the config's base topic. */
const withBase = (topic: string | undefined, base: string | undefined): string | undefined => {
  if (!topic || !base) return topic;
  if (topic.startsWith('~')) return base + topic.slice(1);
  if (topic.endsWith('~')) return topic.slice(0, -1) + base;
  return topic;
};

/** A reading's value: a number when it reads as one, null for Home Assistant's "nothing yet". */
const sensorValue = (raw: unknown): DeviceValue => {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
  const text = String(raw).trim();
  if (text === '' || text === 'unknown' || text === 'unavailable' || text === 'None') return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : text;
};

/** A number from a payload or a JSON field. */
const numberOf = (raw: unknown): number | undefined => {
  const number = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(number) ? number : undefined;
};

/** The JSON schema's colour modes a colour is set in, the first the light has. */
const COLOR_MODES = ['rgb', 'rgbw', 'rgbww', 'hs', 'xy'];

/** A JSON state's `color` as `#rrggbb`: by r, g and b, else hue and saturation, else x and y. */
const colorOf = (raw: unknown): string | undefined => {
  if (raw === null || typeof raw !== 'object') return undefined;
  const color = raw as Config;
  return hexOf(color.r, color.g, color.b) ?? hexOfHs(color.h ?? color.hue, color.s ?? color.saturation) ?? hexOfXy(color.x, color.y);
};

/** A colour as a JSON command's `color`, in the light's colour mode. */
const colorCommand = (mode: string, rgb: Rgb): Config | undefined => {
  if (mode === 'hs') return hsOf(rgb);
  if (mode === 'xy') return xyOf(rgb);
  return { r: rgb[0], g: rgb[1], b: rgb[2] };
};

/** On, off, or neither, by the entity's own words for them. */
const onOff = (raw: unknown, on: string, off: string): DeviceValue => {
  if (typeof raw === 'boolean') return raw;
  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  if (text === on) return true;
  if (text === off) return false;
  return null;
};

type StateRoute = { device: string; entity: string; read: (payload: string) => Update[] };
type AvailabilityRoute = { device: string; on: string; off: string };
/** What one config announced: its entity, and a light's brightness and colour beside it. */
type Known = { device: string; entity: string; entities: string[]; topics: string[]; availability: string[] };

type HaDiscoveryOptions = { prefix?: string };

export const createHaDiscovery = (options: HaDiscoveryOptions = {}): MqttSource & { notes(): string[] } => {
  const prefix = (options.prefix ?? 'homeassistant').replace(/\/+$/, '');
  /** By config topic: what it announced, so a new config or an empty one replaces it. */
  const known = new Map<string, Known>();
  const states = new Map<string, StateRoute[]>();
  const availability = new Map<string, AvailabilityRoute[]>();
  const commands = new Map<string, (command: Command) => Publish[] | undefined>();
  const devices = new Set<string>();
  const skipped = new Map<string, string>();

  const forget = (configTopic: string): Known | undefined => {
    const was = known.get(configTopic);
    if (!was) return undefined;
    for (const topic of was.topics) {
      const left = (states.get(topic) ?? []).filter((route) => !(route.device === was.device && route.entity === was.entity));
      if (left.length) states.set(topic, left);
      else states.delete(topic);
    }
    for (const topic of was.availability) {
      const left = (availability.get(topic) ?? []).filter((route) => route.device !== was.device);
      if (left.length) availability.set(topic, left);
      else availability.delete(topic);
    }
    for (const entity of was.entities) commands.delete(`${was.device}/${entity}`);
    known.delete(configTopic);
    return was;
  };

  /** An entity name not yet taken on the device by another config. */
  const entityName = (device: string, objectId: string, component: string, configTopic: string): string => {
    const base = deviceName(objectId) || deviceName(component);
    const taken = [...known.entries()].some(([topic, each]) => topic !== configTopic && each.device === device && each.entities.includes(base));
    return taken ? `${base}-${deviceName(component)}` : base;
  };

  const announce = (configTopic: string, component: string, nodeId: string | undefined, objectId: string, config: Config): Update[] => {
    const kind = KINDS[component];
    const deviceInfo = (config.device ?? {}) as Config;
    const identifiers = Array.isArray(deviceInfo.identifiers) ? deviceInfo.identifiers : [deviceInfo.identifiers];
    const connections = Array.isArray(deviceInfo.connections) ? deviceInfo.connections as unknown[][] : [];
    const mac = connections.find((pair) => Array.isArray(pair) && pair[0] === 'mac')?.[1];
    const device = deviceName(nodeId ?? str(identifiers[0]) ?? str(deviceInfo.name) ?? objectId);
    if (!device) return [];
    if (!kind) {
      skipped.set(`${device}/${deviceName(objectId)}`, `component ${component} is not read`);
      return [];
    }
    const base = str(config['~']);
    const entity = entityName(device, objectId, component, configTopic);
    const head: Update[] = [];
    const updates: Update[] = [];
    if (!devices.has(device) || deviceInfo.name || deviceInfo.model) {
      devices.add(device);
      head.push({
        kind: 'device',
        device,
        label: str(deviceInfo.name) ?? nodeId ?? device,
        manufacturer: str(deviceInfo.manufacturer),
        model: str(deviceInfo.model),
        firmware: str(deviceInfo.sw_version),
        mac: typeof mac === 'string' ? mac.toLowerCase() : undefined,
        url: /^https?:\/\//.test(str(deviceInfo.configuration_url) ?? '') ? str(deviceInfo.configuration_url) : undefined,
      });
    }

    const topics: string[] = [];
    const route = (topic: string | undefined, read: (payload: string) => Update[]) => {
      if (!topic) return;
      topics.push(topic);
      states.set(topic, [...(states.get(topic) ?? []), { device, entity, read }]);
      updates.push({ kind: 'subscribe', topic });
    };

    let problem: string | undefined;
    const compiled = (key: string): Template | { problem: string } | undefined => {
      const source = str(config[key]);
      return source ? compileTemplate(source) : undefined;
    };
    /** The entity's own template; one it cannot read makes it unsupported. */
    const template = (key: string): Template | undefined => {
      const result = compiled(key);
      if (result === undefined || typeof result === 'function') return result;
      problem = result.problem;
      return undefined;
    };

    const stateTopic = withBase(str(config.state_topic), base);
    const commandTopic = withBase(str(config.command_topic), base);
    const payloadOn = str(config.payload_on) ?? 'ON';
    const payloadOff = str(config.payload_off) ?? 'OFF';
    const state = (value: DeviceValue, name = entity): Update[] => [{ kind: 'state', device, entity: name, value, retained: false }];
    let settable = false;
    const label = str(config.name) ?? (component === 'device_automation' ? labelOf(str(config.subtype) ?? objectId) : labelOf(objectId));
    const entities = [entity];
    /** A light's brightness and colour, announced after the light. */
    const parts: EntityUpdate[] = [];
    const part = (
      suffix: string,
      fields: Pick<EntityUpdate, 'entityKind' | 'unit' | 'min' | 'max' | 'step'>,
      set: ((value: string) => Publish[] | undefined) | undefined,
      problem?: string,
    ): string => {
      const name = `${entity}-${suffix}`;
      entities.push(name);
      if (set && !problem) commands.set(`${device}/${name}`, ({ value }) => set(value));
      parts.push({
        kind: 'entity',
        device,
        entity: name,
        label: `${label} ${suffix === 'color' ? 'colour' : suffix}`,
        ...fields,
        settable: !!set && !problem,
        supported: !problem,
        problem,
      });
      if (problem) skipped.set(`${device}/${name}`, problem);
      else skipped.delete(`${device}/${name}`);
      return name;
    };
    const percent = { entityKind: 'number', unit: '%', min: 0, max: 100, step: 1 } as const;
    /** A light's brightness in % from the light's own scale, and back. */
    const scale = num(config.brightness_scale) ?? 255;
    const percentOf = (raw: unknown): number | undefined => {
      const number = numberOf(raw);
      return number === undefined ? undefined : Math.round(number / scale * 100);
    };
    const levelOf = (value: string): number | undefined => {
      const number = numberOf(value);
      return number === undefined ? undefined : Math.round(Math.min(100, Math.max(0, number)) / 100 * scale);
    };

    if (component === 'sensor' || component === 'number' || component === 'select' || component === 'text') {
      const read = template('value_template');
      route(stateTopic, (payload) => state(sensorValue(read ? read(payload) : payload)));
    } else if (component === 'binary_sensor') {
      const read = template('value_template');
      route(stateTopic, (payload) => state(onOff(read ? read(payload) : payload, payloadOn, payloadOff)));
    } else if (component === 'switch' || component === 'light') {
      const json = component === 'light' && config.schema === 'json';
      const read = template('state_value_template') ?? (component === 'switch' ? template('value_template') : undefined);
      const stateOn = str(config.state_on) ?? payloadOn;
      const stateOff = str(config.state_off) ?? payloadOff;
      const modes = Array.isArray(config.supported_color_modes) ? config.supported_color_modes : [];
      const colorMode = json ? COLOR_MODES.find((mode) => modes.includes(mode)) : undefined;
      /** A JSON command of one field, sent only when the value reads as one. */
      const setJson = <T>(key: string, parse: (value: string) => T | undefined) =>
        commandTopic
          ? (value: string): Publish[] | undefined => {
            const parsed = parse(value);
            return parsed === undefined ? undefined : [{ topic: commandTopic, payload: JSON.stringify({ [key]: parsed }) }];
          }
          : undefined;
      const brightness = json && (config.brightness === true || modes.some((mode) => mode !== 'onoff'))
        ? part('brightness', percent, setJson('brightness', levelOf))
        : undefined;
      const color = colorMode
        ? part(
          'color',
          { entityKind: 'color' },
          setJson('color', (value) => {
            const rgb = rgbOf(value);
            return rgb && colorCommand(colorMode, rgb);
          }),
        )
        : undefined;
      route(stateTopic, (payload) => {
        if (json) {
          let parsed: Config | null;
          try {
            parsed = JSON.parse(payload);
          } catch {
            return [];
          }
          const updates = state(onOff(parsed?.state, 'ON', 'OFF'));
          const level = brightness && percentOf(parsed?.brightness);
          if (brightness && level !== undefined) updates.push(...state(level, brightness));
          const hex = color && colorOf(parsed?.color);
          if (color && hex) updates.push(...state(hex, color));
          return updates;
        }
        return state(onOff(read ? read(payload) : payload, stateOn, stateOff));
      });
      if (component === 'light' && !json) {
        /** The default schema's brightness or rgb, with topics and templates of their own: a number, or `r,g,b`. */
        const lightPart = (
          key: 'brightness' | 'rgb',
          fields: Pick<EntityUpdate, 'entityKind' | 'unit' | 'min' | 'max' | 'step'>,
          read: (raw: unknown) => DeviceValue | undefined,
          write: (value: string) => string | undefined,
        ) => {
          const partState = withBase(str(config[`${key}_state_topic`]), base);
          const partCommand = withBase(str(config[`${key}_command_topic`]), base);
          if (!partState && !partCommand) return;
          const value = compiled(`${key}_value_template`);
          const command = compiled(`${key}_command_template`);
          const problem = [value, command].find((each) => each !== undefined && typeof each !== 'function') as { problem: string } | undefined;
          const name = part(
            key === 'rgb' ? 'color' : key,
            fields,
            partCommand
              ? (raw) => {
                const payload = write(raw);
                if (payload === undefined) return undefined;
                return [{ topic: partCommand, payload: typeof command === 'function' ? String(command(payload)) : payload }];
              }
              : undefined,
            problem?.problem,
          );
          route(partState, (payload) => {
            const reading = read(typeof value === 'function' ? value(payload) : payload);
            return reading === undefined || reading === null ? [] : state(reading, name);
          });
        };
        lightPart('brightness', percent, percentOf, (value) => levelOf(value)?.toString());
        lightPart('rgb', { entityKind: 'color' }, (payload) => {
          const rgb = rgbOf(String(payload ?? ''));
          return rgb && hexOf(...rgb);
        }, (value) => rgbOf(value)?.join(','));
      }
      if (commandTopic) {
        settable = true;
        commands.set(`${device}/${entity}`, ({ value }) => {
          const on = value === 'on';
          const payload = json ? JSON.stringify({ state: on ? 'ON' : 'OFF' }) : on ? payloadOn : payloadOff;
          return [{ topic: commandTopic, payload }];
        });
      }
    } else if (component === 'event') {
      const read = template('value_template');
      route(stateTopic, (payload) => {
        let type: unknown;
        try {
          type = read ? read(payload) : (JSON.parse(payload) as Config).event_type;
        } catch {
          type = undefined;
        }
        return typeof type === 'string' && type ? [{ kind: 'event', device, entity, value: type }] : [];
      });
    } else if (component === 'device_automation') {
      const topic = withBase(str(config.topic), base);
      const payload = str(config.payload);
      const type = str(config.type) ?? 'press';
      route(topic, (message) => payload === undefined || message === payload ? [{ kind: 'event', device, entity, value: type }] : []);
    }

    if ((component === 'number' || component === 'select' || component === 'text') && commandTopic) {
      settable = true;
      commands.set(`${device}/${entity}`, ({ value }) => [{ topic: commandTopic, payload: value }]);
    }
    if (component === 'button' && commandTopic) {
      settable = true;
      const press = str(config.payload_press) ?? 'PRESS';
      commands.set(`${device}/${entity}`, () => [{ topic: commandTopic, payload: press }]);
    }

    const availabilityTopics: string[] = [];
    const list = Array.isArray(config.availability) ? config.availability as Config[] : [];
    const single = str(config.availability_topic);
    const entries = single ? [{ topic: single, payload_available: config.payload_available, payload_not_available: config.payload_not_available }] : list;
    for (const each of entries) {
      const topic = withBase(str(each.topic), base);
      if (!topic) continue;
      availabilityTopics.push(topic);
      const on = str(each.payload_available) ?? 'online';
      const off = str(each.payload_not_available) ?? 'offline';
      availability.set(topic, [...(availability.get(topic) ?? []).filter((route) => route.device !== device), { device, on, off }]);
      updates.push({ kind: 'subscribe', topic });
    }

    head.push({
      kind: 'entity',
      device,
      entity,
      label,
      entityKind: kind,
      unit: str(config.unit_of_measurement),
      deviceClass: str(config.device_class),
      category: config.entity_category === 'diagnostic' || config.entity_category === 'config' ? config.entity_category : undefined,
      options: Array.isArray(config.options) ? config.options.filter((option): option is string => typeof option === 'string') : undefined,
      min: num(config.min),
      max: num(config.max),
      step: num(config.step),
      settable,
      supported: problem === undefined,
      problem,
    }, ...parts);
    if (problem) skipped.set(`${device}/${entity}`, problem);
    else skipped.delete(`${device}/${entity}`);
    known.set(configTopic, { device, entity, entities, topics, availability: availabilityTopics });
    return [...head, ...updates];
  };

  /** `<prefix>/<component>/[<node_id>/]<object_id>/config`, split. */
  const parseConfigTopic = (topic: string): { component: string; nodeId?: string; objectId: string } | undefined => {
    if (!topic.startsWith(`${prefix}/`) || !topic.endsWith('/config')) return undefined;
    const parts = topic.slice(prefix.length + 1, -'/config'.length).split('/');
    if (parts.length === 2) return { component: parts[0], objectId: parts[1] };
    if (parts.length === 3) return { component: parts[0], nodeId: parts[1], objectId: parts[2] };
    return undefined;
  };

  return {
    name: 'ha-discovery',
    description: 'Devices that announce themselves over MQTT the way Home Assistant reads them: ESPHome, Zigbee2MQTT and others',
    topics: () => [`${prefix}/+/+/config`, `${prefix}/+/+/+/config`],
    forget(device) {
      const topics = [...known.entries()].filter(([, each]) => each.device === device).map(([topic]) => topic);
      for (const topic of topics) forget(topic);
      devices.delete(device);
      for (const key of [...skipped.keys()]) if (key.startsWith(`${device}/`)) skipped.delete(key);
      return topics.map((topic) => ({ topic, payload: '', retain: true }));
    },
    notes: () => [...skipped.entries()].map(([what, why]) => `${what}: ${why}`),
    decode(topic, payload, retained) {
      const config = parseConfigTopic(topic);
      if (config) {
        if (payload.trim() === '') {
          const was = forget(topic);
          return was ? was.entities.map((entity) => ({ kind: 'retire', device: was.device, entity })) : [];
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          return [];
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
        forget(topic);
        return announce(topic, config.component, config.nodeId, config.objectId, expand(parsed) as Config);
      }
      const updates: Update[] = [];
      for (const route of states.get(topic) ?? []) {
        for (const update of route.read(payload)) {
          // A retained press is one that already happened: the broker replays it on reconnect.
          if (update.kind === 'event' && retained) continue;
          updates.push(update.kind === 'state' ? { ...update, retained } : update);
        }
      }
      for (const route of availability.get(topic) ?? []) {
        const text = payload.trim();
        if (text === route.on) updates.push({ kind: 'online', device: route.device, online: true });
        else if (text === route.off) updates.push({ kind: 'online', device: route.device, online: false });
      }
      return updates;
    },
    encode(command) {
      return commands.get(`${command.device}/${command.entity}`)?.(command);
    },
  };
};
