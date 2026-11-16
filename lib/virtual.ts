/**
 * The `virtual` driver: devices whose readings are worked out from other devices', and whose
 * controls hold what people and automations set them to.
 *
 *   device-create indoors --driver virtual --class sensor \
 *     --config 'read=temperature=avg hall-sensor/temperature kitchen-sensor/temperature; moving=any hall-sensor/motion kitchen-sensor/motion' \
 *     --config 'set=away=bool; setpoint=number 5..30 0.5 °C; mode=enum eco comfort off'
 *
 * `read`: each reading `name=<fn> <device>/<endpoint> …`, `fn` one of an aggregate node's (avg, min,
 * max, sum, count, any, all, last), over the latest readings of its sources, kept again whenever one
 * of them changes; its unit is its sources'. `set`: each control `name=bool`, `number [min..max]
 * [step] [unit]`, `enum <option> …`, `text` or `momentary`; what is written to it is its state.
 *
 * A reading is worked out with the rights of the devices group and no one's more: a source the
 * group may not read is refused, so an endpoint narrowed to some people is never republished to
 * more. Its endpoint is the group's to read, not to write, or anyone in it could add a reading of
 * their own. A device that reads itself, or a ring of virtual devices that read each other, is
 * refused.
 */

import { type ControlSchema, type DeviceAttrs, DEVICES_GROUPNAME, type EndpointAttrs } from '@ein/api';
import { type Access, ADMIN_ACCESS, type Command } from '@ein/client';
import { DEV_PATH, devicePath } from '@ein/paths';
import type { AutomationValue } from './api.ts';
import { endpointState } from './automation-files.ts';
import type { DeviceEvent } from './automations/engine.ts';
import { type Aggregate, aggregate, AGGREGATES } from './automations/values.ts';
import { gidOf } from './groups.ts';

const VIRTUAL_DRIVER = 'virtual';

type Reading = { name: string; fn: Aggregate; sources: string[] };
type Control = { name: string; schema: ControlSchema; unit?: string };

const ENDPOINT = /^[a-z0-9][a-z0-9_-]*$/;
const SOURCE = /^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/;

const entries = (text: string | undefined): [string, string[]][] =>
  (text ?? '').split(/[;\n]/).map((each) => each.trim()).filter(Boolean).map((entry) => {
    const at = entry.indexOf('=');
    const name = entry.slice(0, at).trim();
    if (at < 1 || !ENDPOINT.test(name)) throw new Error(`'${entry}' is not name=…, the name in lower-case letters, digits, - and _`);
    return [name, entry.slice(at + 1).trim().split(/\s+/).filter(Boolean)];
  });

/** A virtual device's readings and controls from its config; throws, saying which, at one it does not understand. */
export const parseVirtualConfig = (config: Record<string, string> = {}): { readings: Reading[]; controls: Control[] } => {
  const readings = entries(config.read).map(([name, [fn, ...sources]]): Reading => {
    if (!(AGGREGATES as readonly string[]).includes(fn)) throw new Error(`the reading ${name} takes one of ${AGGREGATES.join(', ')} first, not '${fn ?? ''}'`);
    if (!sources.length) throw new Error(`the reading ${name} names no <device>/<endpoint> to read`);
    const wrong = sources.find((source) => !SOURCE.test(source));
    if (wrong) throw new Error(`the reading ${name} reads '${wrong}', which is not <device>/<endpoint>`);
    return { name, fn: fn as Aggregate, sources: [...new Set(sources)] };
  });
  const controls = entries(config.set).map(([name, [type, ...rest]]): Control => {
    switch (type) {
      case 'bool':
      case 'text':
      case 'momentary':
        if (rest.length) throw new Error(`the control ${name}: ${type} takes nothing after it`);
        return { name, schema: { type } };
      case 'enum':
        if (!rest.length) throw new Error(`the control ${name}: enum takes its options, such as enum eco comfort off`);
        return { name, schema: { type, options: rest } };
      case 'number': {
        const schema: ControlSchema & { type: 'number' } = { type: 'number' };
        let unit: string | undefined;
        for (const word of rest) {
          const range = /^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/.exec(word);
          if (range) [schema.min, schema.max] = [Number(range[1]), Number(range[2])];
          else if (Number.isFinite(Number(word)) && schema.step === undefined) schema.step = Number(word);
          else if (unit === undefined) unit = word;
          else throw new Error(`the control ${name}: number takes min..max, a step and a unit, not '${word}'`);
        }
        return { name, schema, ...(unit ? { unit } : {}) };
      }
      default:
        throw new Error(`the control ${name} is bool, number, enum, text or momentary, not '${type ?? ''}'`);
    }
  });
  const names = [...readings, ...controls].map((each) => each.name);
  const twice = names.find((name, index) => names.indexOf(name) !== index);
  if (twice) throw new Error(`${twice} is named twice`);
  return { readings, controls };
};

type VirtualDevice = { readings: Reading[]; controls: Control[] };

/**
 * Start the virtual driver: its devices set up, their readings worked out now and whenever a source
 * changes (`handle`, given every device message), and set up again when a device's config changes.
 */
export const startVirtualDevices = async (cmd: Command, log: (line: string) => Promise<void>) => {
  const { vfs, devices } = cmd.sys;
  if (!devices) throw new Error('devices are not running here');
  const gid = await gidOf(cmd, DEVICES_GROUPNAME);
  /** The devices group's rights, and no one's more. */
  const group: Access = { uid: -1, gid: gid ?? -1, gids: gid === undefined ? [] : [gid] };
  const virtual = new Map<string, VirtualDevice>();
  const values = new Map<string, AutomationValue>();
  /** Each device's config as it was set up from, to know when `attrs -J config=…` changed it. */
  const configs = new Map<string, string>();

  /** The virtual devices a device's readings read from, itself among them when it reads itself. */
  const readsFrom = (device: VirtualDevice) => new Set(device.readings.flatMap((reading) => reading.sources.map((source) => source.split('/')[0])));
  const cycleThrough = (name: string, device: VirtualDevice): string[] | undefined => {
    const walk = (at: string, path: string[]): string[] | undefined => {
      const from = at === name ? device : virtual.get(at);
      for (const next of from ? readsFrom(from) : []) {
        if (next === name) return [...path, next];
        if (!path.includes(next) && virtual.has(next)) {
          const found = walk(next, [...path, next]);
          if (found) return found;
        }
      }
      return undefined;
    };
    return walk(name, [name]);
  };

  const compute = async (name: string, reading: Reading) => {
    const known = reading.sources.flatMap((source) => values.has(source) ? [values.get(source)!] : []);
    const result = aggregate(reading.fn, known);
    if (result !== undefined) await devices.append(ADMIN_ACCESS, name, reading.name, result);
  };

  /** Set a device up from its config; one that cannot be is no longer worked out, and says why. */
  const setup = async (name: string) => {
    try {
      await setupNow(name);
    } catch (error) {
      if (virtual.delete(name)) await devices.online(ADMIN_ACCESS, name, false).catch(() => {});
      throw error;
    }
  };

  const setupNow = async (name: string) => {
    const node = await vfs.get<DeviceAttrs>(ADMIN_ACCESS, devicePath(name));
    configs.set(name, JSON.stringify(node.attrs.config ?? {}));
    const device = parseVirtualConfig(node.attrs.config);
    const cycle = cycleThrough(name, device);
    if (cycle) throw new Error(`its readings go round in a circle: ${cycle.join(' → ')}`);
    const units = new Map<string, string>();
    for (const source of new Set(device.readings.flatMap((reading) => reading.sources))) {
      const state = await endpointState(vfs, group, source);
      if (!state.readable) throw new Error(`the devices group may not read ${source}, or there is no such endpoint, so no reading of a virtual device reads it`);
      if (state.value !== undefined) values.set(source, state.value);
      const [from, endpoint] = source.split('/');
      const unit = (await vfs.get<EndpointAttrs>(ADMIN_ACCESS, `${devicePath(from)}/${endpoint}`).catch(() => undefined))?.attrs.unit;
      if (unit) units.set(source, unit);
    }
    const kept = new Set<string>();
    for (const reading of device.readings) {
      const unit = units.get(reading.sources[0]);
      const sameUnit = unit && reading.sources.every((source) => units.get(source) === unit) && !['count', 'any', 'all'].includes(reading.fn);
      await devices.ensureEndpoint(ADMIN_ACCESS, name, reading.name, 'log', { label: reading.name, ...(sameUnit ? { unit } : {}) }, 0o640);
      kept.add(reading.name);
    }
    for (const control of device.controls) {
      const attrs: EndpointAttrs = { label: control.name, schema: control.schema, minInterval: 0, ...(control.unit ? { unit: control.unit } : {}) };
      await devices.ensureEndpoint(ADMIN_ACCESS, name, control.name, 'control', control.schema.type === 'momentary' ? { ...attrs, events: true } : attrs);
      kept.add(control.name);
    }
    for (const child of await vfs.children(ADMIN_ACCESS, devicePath(name))) {
      if (['log', 'control', 'track'].includes(child.node.type) && !kept.has(child.name)) await devices.removeEndpoint(ADMIN_ACCESS, name, child.name);
    }
    virtual.set(name, device);
    for (const reading of device.readings) await compute(name, reading);
    await devices.online(ADMIN_ACCESS, name, true);
  };

  const unregister = devices.registerDriver(VIRTUAL_DRIVER, {
    description: "A device of readings worked out from other devices' (an average, the most, whether any is on), and controls that hold what is set",
    module: 'automation',
    config: [
      { name: 'read', label: 'Readings: name=avg <device>/<endpoint> <device>/<endpoint>; … (avg, min, max, sum, count, any, all, last)', type: 'string' },
      { name: 'set', label: 'Controls: name=bool; name=number 5..30 0.5 °C; name=enum eco comfort; name=text; name=momentary', type: 'string' },
    ],
    setup,
    write: async (command) => {
      await devices.append(ADMIN_ACCESS, command.device, command.endpoint, command.value ?? null);
    },
    forget: (device) => {
      virtual.delete(device);
      return Promise.resolve();
    },
  });

  for (const child of await vfs.children<DeviceAttrs>(ADMIN_ACCESS, DEV_PATH).catch(() => [])) {
    if (child.node.type === 'device' && child.node.attrs.driver === VIRTUAL_DRIVER) {
      await setup(child.name).catch((error) => log(`virtual device ${child.name}: ${error instanceof Error ? error.message : error}`));
    }
  }

  // `attrs -J config=…` on a device changes it without calling setup: set it up again then.
  const subscription = await vfs.subscribe<DeviceAttrs>?.(() => ADMIN_ACCESS, (event) => {
    const name = event.path.slice(DEV_PATH.length + 1);
    if (event.type !== 'updated' || name.includes('/') || event.node.attrs.driver !== VIRTUAL_DRIVER) return;
    const config = JSON.stringify(event.node.attrs.config ?? {});
    if (configs.get(name) === config) return;
    configs.set(name, config);
    setup(name).catch((error) => log(`virtual device ${name}: ${error instanceof Error ? error.message : error}`));
  }, { pathPrefix: DEV_PATH, nodeTypes: ['device'] });

  return {
    /** A device's message: a reading some virtual device reads works out its readings again. */
    handle: async (event: DeviceEvent) => {
      if (event.endpoint === undefined || event.value === undefined || event.event) return;
      const key = `${event.device}/${event.endpoint}`;
      let wanted = false;
      for (const [name, device] of virtual) {
        for (const reading of device.readings) {
          if (!reading.sources.includes(key)) continue;
          if (!wanted) values.set(key, event.value);
          wanted = true;
          await compute(name, reading).catch((error) => log(`virtual device ${name}: ${error instanceof Error ? error.message : error}`));
        }
      }
    },
    /** Set every virtual device up again: a source the devices group lost stops it, saying why. */
    recheck: async () => {
      for (const child of await vfs.children<DeviceAttrs>(ADMIN_ACCESS, DEV_PATH).catch(() => [])) {
        if (child.node.type !== 'device' || child.node.attrs.driver !== VIRTUAL_DRIVER) continue;
        const was = virtual.has(child.name);
        await setup(child.name).catch((error) => was ? log(`virtual device ${child.name}: ${error instanceof Error ? error.message : error}`) : undefined);
      }
    },
    stop: async () => {
      unregister();
      await subscription?.unsubscribe().catch(() => {});
      for (const name of virtual.keys()) await devices.online(ADMIN_ACCESS, name, false).catch(() => {});
    },
  };
};
