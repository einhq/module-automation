/**
 * Home Assistant's MQTT discovery: a device announces each of its entities as a retained JSON
 * message on `<prefix>/<component>/[<node_id>/]<object_id>/config`, naming the topics its state
 * comes on and its commands go to. ESPHome announces this way when it has an `mqtt:` block, and
 * so do Zigbee2MQTT and others.
 *
 * The device is named by its node id (ESPHome's own name for it), else by its first identifier;
 * the entity by its object id. An empty config message withdraws the entity.
 *
 * Read: `sensor`, `binary_sensor`, `switch`, `light` (on and off, both schemas), `number`,
 * `select`, `text`, `button`, `event` and `device_automation` triggers. Other components are
 * skipped and listed by `notes()`.
 */

import type { EntityKind, Value } from '../api.ts';
import { labelOf, slug } from '../slug.ts';
import { compileTemplate, type Template } from './template.ts';
import type { Command, MqttSource, Publish, Update } from './types.ts';

/** Home Assistant's abbreviations of the keys this source reads. */
const ABBREVIATIONS: Record<string, string> = {
  atype: 'automation_type',
  avty: 'availability',
  avty_mode: 'availability_mode',
  avty_t: 'availability_topic',
  cmd_t: 'command_topic',
  cns: 'connections',
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
  stat_cla: 'state_class',
  stat_off: 'state_off',
  stat_on: 'state_on',
  stat_t: 'state_topic',
  stat_val_tpl: 'state_value_template',
  stype: 'subtype',
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
const sensorValue = (raw: unknown): Value => {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
  const text = String(raw).trim();
  if (text === '' || text === 'unknown' || text === 'unavailable' || text === 'None') return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : text;
};

/** On, off, or neither, by the entity's own words for them. */
const onOff = (raw: unknown, on: string, off: string): Value => {
  if (typeof raw === 'boolean') return raw;
  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  if (text === on) return true;
  if (text === off) return false;
  return null;
};

type StateRoute = { device: string; entity: string; read: (payload: string) => Update[] };
type AvailabilityRoute = { device: string; on: string; off: string };
type Known = { device: string; entity: string; topics: string[]; availability: string[] };

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
    commands.delete(`${was.device}/${was.entity}`);
    known.delete(configTopic);
    return was;
  };

  /** An entity name not yet taken on the device by another config. */
  const entityName = (device: string, objectId: string, component: string, configTopic: string): string => {
    const base = slug(objectId) || slug(component);
    const taken = [...known.entries()].some(([topic, each]) => topic !== configTopic && each.device === device && each.entity === base);
    return taken ? `${base}-${slug(component)}` : base;
  };

  const announce = (configTopic: string, component: string, nodeId: string | undefined, objectId: string, config: Config): Update[] => {
    const kind = KINDS[component];
    const deviceInfo = (config.device ?? {}) as Config;
    const identifiers = Array.isArray(deviceInfo.identifiers) ? deviceInfo.identifiers : [deviceInfo.identifiers];
    const connections = Array.isArray(deviceInfo.connections) ? deviceInfo.connections as unknown[][] : [];
    const mac = connections.find((pair) => Array.isArray(pair) && pair[0] === 'mac')?.[1];
    const device = slug(nodeId ?? str(identifiers[0]) ?? str(deviceInfo.name) ?? objectId);
    if (!device) return [];
    if (!kind) {
      skipped.set(`${device}/${slug(objectId)}`, `component ${component} is not read`);
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
        sw: str(deviceInfo.sw_version),
        mac: typeof mac === 'string' ? mac.toLowerCase() : undefined,
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
    const template = (key: string): Template | undefined => {
      const source = str(config[key]);
      if (!source) return undefined;
      const compiled = compileTemplate(source);
      if (typeof compiled === 'function') return compiled;
      problem = compiled.problem;
      return undefined;
    };

    const stateTopic = withBase(str(config.state_topic), base);
    const commandTopic = withBase(str(config.command_topic), base);
    const payloadOn = str(config.payload_on) ?? 'ON';
    const payloadOff = str(config.payload_off) ?? 'OFF';
    const state = (value: Value, retained: boolean): Update[] => [{ kind: 'state', device, entity, value, retained }];
    let settable = false;

    if (component === 'sensor' || component === 'number' || component === 'select' || component === 'text') {
      const read = template('value_template');
      route(stateTopic, (payload) => state(sensorValue(read ? read(payload) : payload), false));
    } else if (component === 'binary_sensor') {
      const read = template('value_template');
      route(stateTopic, (payload) => state(onOff(read ? read(payload) : payload, payloadOn, payloadOff), false));
    } else if (component === 'switch' || component === 'light') {
      const json = component === 'light' && config.schema === 'json';
      const read = template('state_value_template') ?? (component === 'switch' ? template('value_template') : undefined);
      const stateOn = str(config.state_on) ?? payloadOn;
      const stateOff = str(config.state_off) ?? payloadOff;
      route(stateTopic, (payload) => {
        if (json) {
          try {
            return state(onOff((JSON.parse(payload) as Config).state, 'ON', 'OFF'), false);
          } catch {
            return [];
          }
        }
        return state(onOff(read ? read(payload) : payload, stateOn, stateOff), false);
      });
      if (commandTopic) {
        settable = true;
        commands.set(`${device}/${entity}`, ({ value, current }) => {
          const on = value === 'toggle' ? current !== true : value === 'on';
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

    const label = str(config.name) ?? (component === 'device_automation' ? labelOf(str(config.subtype) ?? objectId) : labelOf(objectId));
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
      settable,
      supported: problem === undefined,
      problem,
    });
    if (problem) skipped.set(`${device}/${entity}`, problem);
    else skipped.delete(`${device}/${entity}`);
    known.set(configTopic, { device, entity, topics, availability: availabilityTopics });
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
    topics: () => [`${prefix}/+/+/config`, `${prefix}/+/+/+/config`],
    owns: (device) => devices.has(device),
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
          return was ? [{ kind: 'retire', device: was.device, entity: was.entity }] : [];
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
