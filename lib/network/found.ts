/**
 * What the network listener heard, as the bridge receives it on the broker: one retained message per
 * host under `ein/discovery/host/<id>` (empty when the listener let it go), and the listener's own
 * `ein/discovery/status`. The broker replays them to every connection, so nothing here is kept
 * across restarts.
 *
 * `foundDevices` names each host (`identify`) and matches it to a device under /dev: by hardware
 * address, or by a name it answers to, which is the name Shelly's and ESPHome's MQTT give it.
 */

import { deviceName } from '@ein/api';
import type { FoundAnswer, FoundDevice, NetworkHost } from '../api.ts';
import { identify, namesOf } from './identify.ts';

/** Where the network listener publishes. */
const NETWORK_PREFIX = 'ein/discovery';

type ListenerStatus = { round?: string; broker?: string };

/** A device under /dev, as much of it as matching needs. */
export type KnownDevice = { name: string; mac?: string };

const HOST_TOPIC = `${NETWORK_PREFIX}/host/`;
const STATUS_TOPIC = `${NETWORK_PREFIX}/status`;

/** A hardware address as twelve lowercase hex digits, whatever it was written with. */
const macKey = (mac: string): string => mac.toLowerCase().replace(/[^0-9a-f]/g, '');

const isHost = (value: unknown): value is NetworkHost => {
  const host = value as NetworkHost;
  return typeof host === 'object' && host !== null && typeof host.ip === 'string' && Array.isArray(host.mdns) && Array.isArray(host.ssdp) &&
    Array.isArray(host.names);
};

export class NetworkHosts {
  readonly hosts = new Map<string, NetworkHost>();
  status: ListenerStatus = {};

  topics(): string[] {
    return [`${NETWORK_PREFIX}/#`];
  }

  /** Takes a message on the listener's topics; false for one that is not its. */
  hear(topic: string, payload: string): boolean {
    if (topic === STATUS_TOPIC) {
      try {
        const status = JSON.parse(payload) as ListenerStatus;
        this.status = { round: typeof status.round === 'string' ? status.round : undefined, broker: typeof status.broker === 'string' ? status.broker : undefined };
      } catch {
        this.status = {};
      }
      return true;
    }
    if (!topic.startsWith(HOST_TOPIC)) return topic.startsWith(`${NETWORK_PREFIX}/`);
    const id = topic.slice(HOST_TOPIC.length);
    if (!payload) {
      this.hosts.delete(id);
      return true;
    }
    try {
      const host = JSON.parse(payload);
      if (isHost(host)) this.hosts.set(id, host);
    } catch {
      // Not the listener's JSON: nothing to keep.
    }
    return true;
  }
}

/** Every host heard, named, with the device under /dev it is when it is one. */
export const foundDevices = (network: NetworkHosts, devices: KnownDevice[], ignored: Set<string>): FoundAnswer => {
  const byMac = new Map(devices.filter((device) => device.mac).map((device) => [macKey(device.mac!), device.name]));
  const byName = new Set(devices.map((device) => device.name));
  const found: FoundDevice[] = [...network.hosts].map(([id, host]) => {
    const device = (host.mac ? byMac.get(macKey(host.mac)) : undefined) ?? namesOf(host).map(deviceName).find((name) => byName.has(name));
    return {
      ...identify(host),
      id,
      ip: host.ip,
      ...(host.mac ? { mac: host.mac } : {}),
      names: host.names,
      seen: host.seen,
      services: [...new Set([...host.mdns.map((each) => each.type), ...host.ssdp.flatMap((each) => each.deviceType ? [each.deviceType] : [])])],
      ...(device ? { device } : {}),
      ignored: ignored.has(id),
    };
  });
  found.sort((a, b) => Number(b.addable) - Number(a.addable) || a.label.localeCompare(b.label));
  return { ...network.status, devices: found };
};
