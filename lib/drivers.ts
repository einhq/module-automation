/**
 * What the sources say, written to core's devices (`cmd.sys.devices`), and what is written to a
 * device's control said back to the device.
 *
 * A device a source announces is `/dev/<device>`, driven by the source's driver; each entity an
 * endpoint under it: a reading a `log`, a button's presses a `log` of events, what can be set a
 * `control` whose schema says what it takes. A state or a press is appended to its endpoint, which
 * core keeps and publishes on `dev.<device>.<endpoint>`, dropping a repeat and holding back a number
 * that comes sooner than the endpoint's `minInterval`. Nodes are written when a device or an entity
 * is announced or changes, never per reading.
 *
 * Changes are applied one at a time, in the order they came.
 */

import type { Command, ModuleDevices } from '@ein/client';
import type { ControlSchema, DeviceAttrs, DeviceValue, EndpointAttrs, EndpointType } from '@ein/api';
import { devicePath } from '@ein/paths';
import type { DeviceChange, DeviceUpdate, EntityUpdate } from './sources/mod.ts';

type WriterOptions = {
  cmd: Command;
  devices: ModuleDevices;
  /** A new endpoint's history: `365 day`, `forever`. */
  retention: string;
  /** A new endpoint's shortest time between two published numbers, in seconds. */
  minInterval: number;
  log(line: string): void;
};

/** An endpoint's type and, for a control, what it takes, by what its entity is. */
const endpointOf = (update: EntityUpdate): { type: EndpointType; schema?: ControlSchema; events?: true } => {
  if (update.entityKind === 'button') return { type: 'log', events: true };
  if (!update.settable) return { type: 'log' };
  switch (update.entityKind) {
    case 'switch':
    case 'light':
      return { type: 'control', schema: { type: 'bool' } };
    case 'number':
      return { type: 'control', schema: defined({ type: 'number' as const, min: update.min, max: update.max, step: update.step }) as ControlSchema };
    case 'text':
      return { type: 'control', schema: update.options?.length ? { type: 'enum', options: update.options } : { type: 'text' } };
    case 'action':
      return { type: 'control', schema: { type: 'momentary' } };
    default:
      return { type: 'log' };
  }
};

/**
 * What a device is, by the first of its entities that says: a plug, a light, a switch, a button or
 * a sensor. One about the device itself (its own temperature, its signal) does not say.
 */
const classOf = (update: EntityUpdate): string | undefined => {
  if (update.category) return undefined;
  switch (update.entityKind) {
    case 'switch':
      return update.deviceClass === 'outlet' ? 'plug' : 'switch';
    case 'light':
      return 'light';
    case 'button':
      return 'button';
    case 'sensor':
    case 'binary':
      return 'sensor';
    default:
      return undefined;
  }
};

/** A value written to a control, as a source's command takes it. */
export const commandValue = (value: DeviceValue): string => value === true ? 'on' : value === false ? 'off' : value === null ? '' : String(value);

const defined = <T extends Record<string, unknown>>(record: T): T => Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;

/** Whether `patch` would change any of `attrs`. */
const changes = (attrs: Record<string, unknown>, patch: Record<string, unknown>): boolean =>
  Object.entries(patch).some(([key, value]) => JSON.stringify(attrs[key]) !== JSON.stringify(value));

export class DeviceWriter {
  /** The devices this writer drives, by name, with their driver. */
  private readonly devices = new Map<string, string>();
  /** The endpoints it made or found, by `<device>/<entity>`, with their type. */
  private readonly endpoints = new Map<string, EndpointType>();
  /** Devices another driver has, said once each. */
  private readonly refused = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: WriterOptions) {}

  /** Apply a change from the source whose driver is `driver`, after those before it. */
  apply(change: DeviceChange, driver: string): Promise<void> {
    this.chain = this.chain.then(() => this.applyNow(change, driver)).catch((error) => {
      this.options.log(`${change.kind} ${change.device}: ${error instanceof Error ? error.message : error}`);
    });
    return this.chain;
  }

  /** Let go of a device, once what came for it before is applied. */
  forget(device: string): Promise<void> {
    this.chain = this.chain.then(() => {
      this.devices.delete(device);
      for (const key of [...this.endpoints.keys()]) if (key.startsWith(`${device}/`)) this.endpoints.delete(key);
    });
    return this.chain;
  }

  /** Apply what waits, and nothing after it. */
  async close(): Promise<void> {
    await this.chain;
    this.closed = true;
  }

  private get access() {
    return this.options.cmd.access;
  }

  private async attrsOf<T>(path: string): Promise<T | undefined> {
    return (await this.options.cmd.sys.vfs.get(this.access, path).catch(() => undefined))?.attrs as T | undefined;
  }

  private async applyNow(change: DeviceChange, driver: string): Promise<void> {
    if (this.closed) return;
    const { devices } = this.options;
    switch (change.kind) {
      case 'device':
        return await this.ensureDevice(change, driver);
      case 'entity':
        return await this.ensureEntity(change, driver);
      case 'state':
        if (this.endpoints.has(`${change.device}/${change.entity}`)) {
          await devices.append(this.access, change.device, change.entity, change.value, { retained: change.retained });
        }
        return;
      case 'event':
        if (this.endpoints.has(`${change.device}/${change.entity}`)) await devices.append(this.access, change.device, change.entity, change.value);
        return;
      case 'online':
        if (this.devices.get(change.device) === driver) await devices.online(this.access, change.device, change.online);
        return;
      case 'retire': {
        const type = this.endpoints.get(`${change.device}/${change.entity}`);
        if (!type) return;
        await devices.ensureEndpoint(this.access, change.device, change.entity, type, { retired: true });
        this.endpoints.delete(`${change.device}/${change.entity}`);
        return;
      }
    }
  }

  private async ensureDevice(update: DeviceUpdate, driver: string): Promise<void> {
    const was = await this.attrsOf<DeviceAttrs>(devicePath(update.device));
    if (was && was.driver !== driver) {
      if (!this.refused.has(update.device)) {
        this.options.log(`${devicePath(update.device)} is ${was.driver ? `the ${was.driver} driver's` : 'driven by no driver'}: ${driver} leaves it alone`);
      }
      this.refused.add(update.device);
      return;
    }
    // Core keeps the label a device was made with, or a person gave it, over a source's later word.
    const attrs: DeviceAttrs = defined({
      label: update.label,
      driver,
      manufacturer: update.manufacturer,
      model: update.model,
      firmware: update.firmware,
      mac: update.mac,
    });
    const { label: _label, ...kept } = attrs;
    if (!was || changes(was, kept)) await this.options.devices.ensureDevice(this.access, update.device, attrs);
    this.devices.set(update.device, driver);
  }

  private async ensureEntity(update: EntityUpdate, driver: string): Promise<void> {
    if (this.devices.get(update.device) !== driver) return;
    const path = `${devicePath(update.device)}/${update.entity}`;
    const was = await this.attrsOf<EndpointAttrs>(path);
    const { type, schema, events } = endpointOf(update);
    // What was given only when it was made (its history, how often a number is kept) can be changed
    // on it since; core keeps its label as a device's.
    const attrs: EndpointAttrs = defined({
      label: update.label,
      unit: update.unit,
      deviceClass: update.deviceClass,
      category: update.category,
      events,
      schema,
      supported: update.supported ? (was?.supported === false ? true : undefined) : false,
      retired: was?.retired ? false : undefined,
      minInterval: was || events ? undefined : this.options.minInterval,
      retention: was ? undefined : this.options.retention,
    });
    await this.options.devices.ensureEndpoint(this.access, update.device, update.entity, type, attrs);
    this.endpoints.set(`${update.device}/${update.entity}`, type);

    const deviceClass = classOf(update);
    if (deviceClass && !(await this.attrsOf<DeviceAttrs>(devicePath(update.device)))?.class) {
      await this.options.devices.ensureDevice(this.access, update.device, { class: deviceClass });
    }
  }
}
