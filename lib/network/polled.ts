/**
 * The drivers that ask a device on the network themselves, over its own protocol, rather than hear
 * it on the broker:
 *
 * - `network`: any host; whether it answers, and how fast (a TCP connection to one of its ports,
 *   which a refusal answers as well as an accept);
 * - `ipp`: a printer; its state, warnings and the level of each ink or toner (IPP);
 * - `snmp`: a NAS, a router or anything else that answers SNMP; its uptime, load, memory, each
 *   volume's use and its temperatures, from the standard MIBs (Host Resources, net-snmp's UCD);
 * - `cast`: a Google Cast device; whether it plays and what (title, artist and app as one line), its
 *   volume and mute, which can be set, and play, pause and stop;
 * - `http`: a web API that answers JSON, at an address rather than a host (`http.ts`): a Shelly's or
 *   Tasmota's own, the weather, the price of electricity; the readings a person names in it, and
 *   the controls, each an address asked to set it.
 *
 * Each poll says what the device is as the sources do (`DeviceChange`s), which the device writer
 * makes endpoints of; a device that does not answer is offline.
 */

import { deviceName, type DeviceValue, type DriverConfigField } from '@ein/api';
import type { Fetch } from './adopt.ts';
import { castCommand, castStatus } from './cast.ts';
import { checkHttpConfig, controlAddress, deviceClassOfUnit, expandUrl, fetchAnswer, intervalOf, parseControls, parseReadings, readAnswer, switchState } from './http.ts';
import { getPrinterAttributes } from './ipp.ts';
import { snmpGet, type SnmpValue, snmpWalk } from './snmp.ts';
import type { DeviceChange, EntityUpdate } from '../sources/mod.ts';

/** A device of one of these drivers, where it is now. */
export type PolledDevice = {
  name: string;
  /** Its address on the network; empty for a driver that is not `addressed`. */
  ip: string;
  /** The port the host offered a service on, to try first. */
  port?: number;
  /** A printer's IPP resource (`ipp/print`). */
  path?: string;
  /** The SNMP community it answers. */
  community?: string;
  /** The port its SNMP agent answers on, when not 161. */
  snmpPort?: number;
  /** What a person gave its driver. */
  config: Record<string, string>;
};

export type PolledDriver = {
  name: string;
  description: string;
  /** How often its devices are asked, unless `intervalOf` says for one. */
  intervalMs: number;
  /** How often a device is asked, from its config. */
  intervalOf?(config: Record<string, string>): number;
  /** False for a driver whose devices are asked at an address in their config, not at a host's. */
  addressed?: false;
  /** What a person gives when making one of its devices; the host's address unless said. */
  config?: DriverConfigField[];
  /** Checks a device's config when a person makes it; throws saying what is wrong. */
  check?(config: Record<string, string>): void;
  /** What the device says now; throws when it does not answer. */
  poll(device: PolledDevice): Promise<{ entities: EntityUpdate[]; values: Record<string, DeviceValue> }>;
  /** Sends a value written to one of its controls. */
  write?(device: PolledDevice, endpoint: string, value: DeviceValue): Promise<void>;
};

const entity = (device: string, name: string, more: Partial<EntityUpdate> & Pick<EntityUpdate, 'entityKind'>): EntityUpdate => ({
  kind: 'entity',
  device,
  entity: name,
  label: name.replace(/-/g, ' '),
  settable: false,
  supported: true,
  ...more,
});

/** The ports a host answers on more often than not, tried after the one it offered. */
const COMMON_PORTS = [80, 443, 445, 22, 631, 8009, 8080];
const CONNECT_TIMEOUT_MS = 3000;

/** How long a TCP connection to `ip` takes to be accepted or refused, in ms; throws when it is neither. */
export const reach = async (ip: string, ports: number[]): Promise<number> => {
  for (const port of ports) {
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const connection = await Promise.race([
        Deno.connect({ hostname: ip, port }),
        new Promise<never>((_, reject) => timer = setTimeout(() => reject(new Deno.errors.TimedOut()), CONNECT_TIMEOUT_MS)),
      ]);
      connection.close();
      return Math.round(performance.now() - started);
    } catch (error) {
      if (error instanceof Deno.errors.ConnectionRefused) return Math.round(performance.now() - started);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${ip} does not answer`);
};

const portsOf = (device: PolledDevice): number[] => [...new Set([...(device.port ? [device.port] : []), ...COMMON_PORTS])];

const network: PolledDriver = {
  name: 'network',
  description: 'Any device on the network: whether it answers, and how fast',
  intervalMs: 60_000,
  poll: async (device) => ({
    entities: [entity(device.name, 'response-time', { entityKind: 'sensor', unit: 'ms', label: 'response time', category: 'diagnostic' })],
    values: { 'response-time': await reach(device.ip, portsOf(device)) },
  }),
};

/** RFC 8011's printer-state. */
const PRINTER_STATES: Record<number, string> = { 3: 'idle', 4: 'printing', 5: 'stopped' };

const createIpp = (fetcher: Fetch): PolledDriver => ({
  name: 'ipp',
  description: 'A network printer, over IPP: its state, its warnings and how much of each ink or toner is left',
  intervalMs: 120_000,
  poll: async (device) => {
    const attributes = await getPrinterAttributes(fetcher, device.ip, device.port === 631 || !device.port ? 631 : device.port, device.path);
    const entities = [
      entity(device.name, 'state', { entityKind: 'sensor', label: 'state' }),
      entity(device.name, 'warnings', { entityKind: 'sensor', label: 'warnings' }),
    ];
    const reasons = (attributes['printer-state-reasons'] ?? []).map(String).filter((reason) => reason !== 'none');
    const values: Record<string, DeviceValue> = {
      state: PRINTER_STATES[Number(attributes['printer-state']?.[0])] ?? 'unknown',
      warnings: reasons.length ? reasons.join(', ') : 'none',
    };
    const names = attributes['marker-names'] ?? [];
    const levels = attributes['marker-levels'] ?? [];
    names.forEach((name, index) => {
      const level = Number(levels[index]);
      // Below zero is IPP's "unknown" or "some left", which no number says.
      if (!Number.isFinite(level) || level < 0) return;
      const id = deviceName(String(name)) || `marker-${index}`;
      entities.push(entity(device.name, id, { entityKind: 'sensor', unit: '%', label: String(name) }));
      values[id] = level;
    });
    const pages = Number(attributes['printer-impressions-completed']?.[0]);
    if (Number.isFinite(pages)) {
      entities.push(entity(device.name, 'pages', { entityKind: 'sensor', label: 'pages printed' }));
      values.pages = pages;
    }
    return { entities, values };
  },
});

/** The SNMP community asked when a device names none: the read-only default most devices ship with. */
export const DEFAULT_COMMUNITY = 'public';

const OID = {
  descr: '1.3.6.1.2.1.1.1.0',
  uptime: '1.3.6.1.2.1.1.3.0',
  /** HOST-RESOURCES-MIB hrStorageEntry: .2 type, .3 description, .4 allocation units, .5 size, .6 used. */
  storage: '1.3.6.1.2.1.25.2.3.1',
  fixedDisk: '1.3.6.1.2.1.25.2.1.4',
  ram: '1.3.6.1.2.1.25.2.1.2',
  /** UCD-SNMP-MIB laLoad.1, the load average over a minute. */
  load: '1.3.6.1.4.1.2021.10.1.3.1',
  /** LM-SENSORS-MIB lmTempSensorsEntry: .2 name, .3 value in thousandths of °C. */
  temperatures: '1.3.6.1.4.1.2021.13.16.2.1',
};

/** Volumes that are a system's own rather than storage: memory, devices, the container's files. */
const SYSTEM_MOUNT = /^\/(dev|run|sys|proc|etc|boot)(\/|$)/;
const GB = 1024 ** 3;

/** A table walked, as row index → column → value. */
const rows = (walked: { oid: string; value: SnmpValue }[], root: string): Map<string, Map<number, SnmpValue>> => {
  const table = new Map<string, Map<number, SnmpValue>>();
  for (const { oid, value } of walked) {
    const [column, ...index] = oid.slice(root.length + 1).split('.');
    const key = index.join('.');
    if (!table.has(key)) table.set(key, new Map());
    table.get(key)!.set(Number(column), value);
  }
  return table;
};

const createSnmp = (): PolledDriver => ({
  name: 'snmp',
  description: 'A NAS, a router or anything that answers SNMP: its uptime, load, memory, volumes and temperatures',
  intervalMs: 60_000,
  config: [
    { name: 'ip', label: 'Address on the network', type: 'string', required: true },
    { name: 'community', label: 'SNMP community', type: 'string' },
  ],
  poll: async (device) => {
    const target = { host: device.ip, port: device.snmpPort, community: device.community || DEFAULT_COMMUNITY };
    const system = await snmpGet(target, [OID.uptime, OID.load]);
    const entities: EntityUpdate[] = [];
    const values: Record<string, DeviceValue> = {};
    const uptime = Number(system.get(OID.uptime));
    if (Number.isFinite(uptime)) {
      entities.push(entity(device.name, 'uptime', { entityKind: 'sensor', unit: 'd', label: 'uptime', category: 'diagnostic' }));
      values.uptime = Math.round(uptime / 100 / 86_400 * 10) / 10;
    }
    const load = Number(system.get(OID.load));
    if (Number.isFinite(load)) {
      entities.push(entity(device.name, 'load', { entityKind: 'sensor', label: 'load', category: 'diagnostic' }));
      values.load = load;
    }
    for (const row of rows(await snmpWalk(target, OID.storage).catch(() => []), OID.storage).values()) {
      const [type, name, units, size, used] = [row.get(2), String(row.get(3) ?? ''), Number(row.get(4)), Number(row.get(5)), Number(row.get(6))];
      if (!(units > 0 && size > 0 && Number.isFinite(used))) continue;
      if (type === OID.ram && name === 'Physical memory') {
        entities.push(entity(device.name, 'memory-used', { entityKind: 'sensor', unit: '%', label: 'memory used', category: 'diagnostic' }));
        values['memory-used'] = Math.round(used / size * 1000) / 10;
      } else if (type === OID.fixedDisk && !SYSTEM_MOUNT.test(name) && size * units >= GB) {
        const id = name === '/' ? 'root' : deviceName(name) || 'volume';
        entities.push(
          entity(device.name, `${id}-used`, { entityKind: 'sensor', unit: '%', label: `${name} used` }),
          entity(device.name, `${id}-free`, { entityKind: 'sensor', unit: 'GB', label: `${name} free` }),
        );
        values[`${id}-used`] = Math.round(used / size * 1000) / 10;
        values[`${id}-free`] = Math.round((size - used) * units / GB * 10) / 10;
      }
    }
    for (const row of rows(await snmpWalk(target, OID.temperatures).catch(() => []), OID.temperatures).values()) {
      const [name, value] = [String(row.get(2) ?? ''), Number(row.get(3))];
      if (!name || !Number.isFinite(value)) continue;
      const id = `${deviceName(name) || 'sensor'}-temperature`;
      entities.push(entity(device.name, id, { entityKind: 'sensor', unit: '°C', deviceClass: 'temperature', label: `${name} temperature` }));
      values[id] = Math.round(value / 100) / 10;
    }
    return { entities, values };
  },
});

/** Whether the host at `ip` answers SNMP with `community`. */
export const answersSnmp = (ip: string, community: string): Promise<boolean> => snmpGet({ host: ip, community }, [OID.descr]).then((values) => values.size > 0, () => false);

const CAST_ACTIONS = ['play', 'pause', 'stop'] as const;

const cast: PolledDriver = {
  name: 'cast',
  description: 'A Google Cast speaker or screen: what it plays, its volume and mute, play, pause and stop',
  intervalMs: 15_000,
  poll: async (device) => {
    const status = await castStatus(device.ip);
    const entities = [
      entity(device.name, 'volume', { entityKind: 'number', unit: '%', min: 0, max: 100, step: 1, settable: true }),
      entity(device.name, 'muted', { entityKind: 'switch', settable: true }),
      entity(device.name, 'player', { entityKind: 'sensor', label: 'player' }),
      entity(device.name, 'playing', { entityKind: 'sensor', label: 'playing' }),
      ...CAST_ACTIONS.map((action) => entity(device.name, action, { entityKind: 'action', settable: true })),
    ];
    const what = [status.title, status.artist].filter(Boolean).join(' – ');
    const values: Record<string, DeviceValue> = {
      player: (status.player ?? 'IDLE').toLowerCase(),
      playing: what && status.app ? `${what} (${status.app})` : what || status.app || null,
    };
    if (status.volume !== undefined) values.volume = Math.round(status.volume * 100);
    if (status.muted !== undefined) values.muted = status.muted;
    return { entities, values };
  },
  write: async (device, endpoint, value) => {
    if (endpoint === 'volume') return await castCommand(device.ip, { type: 'volume', level: Number(value) / 100 });
    if (endpoint === 'muted') return await castCommand(device.ip, { type: 'mute', muted: value === true });
    const action = CAST_ACTIONS.find((each) => each === endpoint);
    if (!action) throw new Error(`${endpoint} cannot be set`);
    await castCommand(device.ip, { type: action });
  },
};

const createHttp = (fetcher: Fetch): PolledDriver => ({
  name: 'http',
  description: 'A web API that answers JSON: a Shelly or Tasmota asked over HTTP, the weather, the price of electricity; the readings and controls you name in it',
  intervalMs: intervalOf(undefined),
  intervalOf: (config) => intervalOf(config.interval),
  addressed: false,
  config: [
    { name: 'url', label: 'Address to ask, with {date}, {year}, {month}, {day} or {hour} for when', type: 'url', required: true },
    { name: 'read', label: 'Readings, as name=path unit; name=path unit', type: 'string', required: true },
    { name: 'set', label: 'Controls, as name=address on/off, with {value} in the address', type: 'string' },
    { name: 'interval', label: 'How often, in seconds or as 15m', type: 'string' },
  ],
  check: checkHttpConfig,
  poll: async (device) => {
    const readings = parseReadings(device.config.read ?? '');
    const controls = parseControls(device.config.set ?? '');
    const values = readAnswer(await fetchAnswer(fetcher, expandUrl(device.config.url ?? '', new Date())), readings);
    if (!Object.keys(values).length) throw new Error('none of its readings is in the answer');
    for (const control of controls) {
      if (control.on === undefined || !(control.name in values)) continue;
      const state = switchState(control, values[control.name]);
      if (state === undefined) delete values[control.name];
      else values[control.name] = state;
    }
    const entities = [
      ...readings.filter((reading) => !controls.some((control) => control.name === reading.name)).map((reading) =>
        entity(device.name, reading.name, {
          entityKind: 'sensor',
          label: reading.label,
          ...(reading.unit ? { unit: reading.unit } : {}),
          ...(deviceClassOfUnit(reading.unit) ? { deviceClass: deviceClassOfUnit(reading.unit) } : {}),
        })
      ),
      ...controls.map((control) => entity(device.name, control.name, { entityKind: control.on === undefined ? 'action' : 'switch', label: control.label, settable: true })),
    ];
    return { entities, values };
  },
  write: async (device, endpoint, value) => {
    const control = parseControls(device.config.set ?? '').find((each) => each.name === endpoint);
    if (!control) throw new Error(`${endpoint} cannot be set`);
    await fetchAnswer(fetcher, controlAddress(control, expandUrl(device.config.url ?? '', new Date()), value));
  },
});

/** The polled drivers, by name. */
export const createPolledDrivers = (fetcher: Fetch): PolledDriver[] => [network, createIpp(fetcher), createSnmp(), cast, createHttp(fetcher)];

/** The names of the polled drivers. */
export const POLLED_DRIVERS: readonly string[] = ['network', 'ipp', 'snmp', 'cast', 'http'];

/** What one poll says, as the changes the device writer applies. */
export const changesOf = (device: string, polled: { entities: EntityUpdate[]; values: Record<string, DeviceValue> }, known: Set<string>): DeviceChange[] => [
  ...polled.entities.filter((each) => !known.has(each.entity)),
  ...Object.entries(polled.values).map(([name, value]): DeviceChange => ({ kind: 'state', device, entity: name, value, retained: false })),
  { kind: 'online', device, online: true },
];
