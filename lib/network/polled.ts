/**
 * The drivers that ask a device on the network themselves, over its own protocol, rather than hear
 * it on the broker:
 *
 * - `network`: any host; whether it answers, and how fast (a TCP connection to one of its ports,
 *   which a refusal answers as well as an accept);
 * - `ipp`: a printer; its state, warnings and the level of each ink or toner (IPP);
 * - `cast`: a Google Cast device; the app running, what it plays, its volume and mute, which can be
 *   set, and play, pause and stop.
 *
 * Each poll says what the device is as the sources do (`DeviceChange`s), which the device writer
 * makes endpoints of; a device that does not answer is offline.
 */

import { deviceName, type DeviceValue } from '@ein/api';
import type { Fetch } from './adopt.ts';
import { castCommand, castStatus } from './cast.ts';
import { getPrinterAttributes } from './ipp.ts';
import type { DeviceChange, EntityUpdate } from '../sources/mod.ts';

/** A device of one of these drivers, where it is now. */
export type PolledDevice = {
  name: string;
  ip: string;
  /** The port the host offered a service on, to try first. */
  port?: number;
  /** A printer's IPP resource (`ipp/print`). */
  path?: string;
};

export type PolledDriver = {
  name: string;
  description: string;
  /** How often its devices are asked. */
  intervalMs: number;
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
      entity(device.name, 'title', { entityKind: 'sensor' }),
      entity(device.name, 'artist', { entityKind: 'sensor' }),
      entity(device.name, 'app', { entityKind: 'sensor' }),
      ...CAST_ACTIONS.map((action) => entity(device.name, action, { entityKind: 'action', settable: true })),
    ];
    const values: Record<string, DeviceValue> = {
      player: (status.player ?? 'IDLE').toLowerCase(),
      title: status.title || null,
      artist: status.artist || null,
      app: status.app || null,
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

/** The polled drivers, by name. */
export const createPolledDrivers = (fetcher: Fetch): PolledDriver[] => [network, createIpp(fetcher), cast];

/** The names of the polled drivers. */
export const POLLED_DRIVERS: readonly string[] = ['network', 'ipp', 'cast'];

/** What one poll says, as the changes the device writer applies. */
export const changesOf = (device: string, polled: { entities: EntityUpdate[]; values: Record<string, DeviceValue> }, known: Set<string>): DeviceChange[] => [
  ...polled.entities.filter((each) => !known.has(each.entity)),
  ...Object.entries(polled.values).map(([name, value]): DeviceChange => ({ kind: 'state', device, entity: name, value, retained: false })),
  { kind: 'online', device, online: true },
];
