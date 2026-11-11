/**
 * Runs the polled drivers (`polled.ts`) in the bridge: registers each with core, and asks each of
 * their devices under /dev as often as its driver says, one device at a time. A device follows its
 * host on the network: its `config.found` is the id the network listener knows it by, so a new
 * address from DHCP is the one asked, and its web page (`url`) follows it; `config.ip` is the address
 * it was last at, and the one a person gives with `device-create --driver network --config ip=…`.
 * A driver that is not `addressed` (`http`) asks at an address in the device's config instead, as
 * often as the device's config says.
 */

import type { DeviceAttrs } from '@ein/api';
import { ADMIN_ACCESS, type Command, type ModuleDevices } from '@ein/client';
import { DEV_PATH, devicePath } from '@ein/paths';
import type { DeviceWriter } from '../drivers.ts';
import type { NetworkHosts } from './found.ts';
import { webPageOf } from './identify.ts';
import { changesOf, type PolledDevice, type PolledDriver } from './polled.ts';

type PollerOptions = {
  cmd: Command;
  devices: ModuleDevices;
  writer: DeviceWriter;
  network: NetworkHosts;
  drivers: PolledDriver[];
  log(line: string): void;
};

const TICK_MS = 5000;

type Poller = {
  /** Ask `device` now rather than when it is next due. */
  pollNow(device: string): void;
  stop(): void;
};

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const startPoller = (options: PollerOptions): Poller => {
  const { cmd, devices, writer, network, log } = options;
  const byName = new Map(options.drivers.map((driver) => [driver.name, driver]));
  /** When each device was last asked. */
  const asked = new Map<string, number>();
  /** The endpoints announced to the writer since the bridge started, by device. */
  const announced = new Map<string, Set<string>>();
  /** Devices that did not answer last time, so it is said once. */
  const silent = new Set<string>();
  /** Devices to ask as soon as the round under way is done. */
  const pending = new Set<string>();
  let busy = false;
  let stopped = false;

  /** Where the device is now: its host's address while the listener hears it, else its last. */
  const locate = (name: string, attrs: DeviceAttrs): PolledDevice | undefined => {
    const config = attrs.config ?? {};
    if (byName.get(attrs.driver ?? '')?.addressed === false) return { name, ip: '', config };
    const host = config.found ? network.hosts.get(config.found) : undefined;
    const ip = host?.ip ?? config.ip;
    if (!ip) return undefined;
    const port = Number(config.port) || host?.mdns.find((each) => each.port)?.port;
    return {
      name,
      ip,
      ...(port ? { port } : {}),
      ...(config.path ? { path: config.path } : {}),
      ...(config.community ? { community: config.community } : {}),
      ...(Number(config['snmp-port']) ? { snmpPort: Number(config['snmp-port']) } : {}),
      config,
    };
  };

  /** How often a device is asked: as its config says, else as its driver does. */
  const intervalOf = (attrs: DeviceAttrs): number => {
    const driver = byName.get(attrs.driver!)!;
    try {
      return driver.intervalOf?.(attrs.config ?? {}) ?? driver.intervalMs;
    } catch {
      return driver.intervalMs;
    }
  };

  const ours = async () => {
    const children = await cmd.sys.vfs.children<DeviceAttrs>(ADMIN_ACCESS, DEV_PATH).catch(() => []);
    return children.filter((child) => child.node.type === 'device' && byName.has(child.node.attrs.driver ?? ''));
  };

  const pollOne = async (name: string, attrs: DeviceAttrs) => {
    const driver = byName.get(attrs.driver!)!;
    asked.set(name, Date.now());
    const where = locate(name, attrs);
    if (!announced.has(name)) {
      await writer.apply({ kind: 'device', device: name, label: attrs.label ?? name, manufacturer: attrs.manufacturer, model: attrs.model, mac: attrs.mac }, driver.name);
      announced.set(name, new Set());
    }
    try {
      if (!where) throw new Error('its address is not known');
      const polled = await driver.poll(where);
      const known = announced.get(name)!;
      for (const change of changesOf(name, polled, known)) await writer.apply(change, driver.name);
      for (const each of polled.entities) known.add(each.entity);
      const host = attrs.config?.found ? network.hosts.get(attrs.config.found) : undefined;
      const url = host ? webPageOf(host) : attrs.url;
      if (driver.addressed !== false && (where.ip !== attrs.config?.ip || url !== attrs.url)) {
        await devices.ensureDevice(cmd.access, name, { config: { ...attrs.config, ip: where.ip }, ...(url ? { url } : {}) });
      }
      silent.delete(name);
    } catch (error) {
      if (!silent.has(name)) log(`${name}: ${message(error)}`);
      silent.add(name);
      await writer.apply({ kind: 'online', device: name, online: false }, driver.name);
    }
  };

  /** Asks every device that is due, and those asked for now. */
  const tick = async (now?: string) => {
    if (now) pending.add(now);
    if (busy || stopped) return;
    busy = true;
    try {
      do {
        const wanted = new Set(pending);
        pending.clear();
        for (const child of await ours()) {
          const due = (asked.get(child.name) ?? 0) + intervalOf(child.node.attrs) <= Date.now();
          if (due || wanted.has(child.name)) await pollOne(child.name, child.node.attrs);
          if (stopped) return;
        }
      } while (pending.size);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => tick().catch((error) => log(`polling: ${message(error)}`)), TICK_MS);
  const unregister = options.drivers.map((driver) =>
    devices.registerDriver(driver.name, {
      description: driver.description,
      module: 'automation',
      config: driver.config ?? [{ name: 'ip', label: 'Address on the network', type: 'string', required: true }],
      ...(driver.write
        ? {
          write: async ({ device, endpoint, attrs, value, by }) => {
            const where = locate(device, attrs);
            if (!where) throw new Error(`the address of ${device} is not known`);
            await driver.write!(where, endpoint, value);
            log(`${device}/${endpoint} set to ${value} by ${by}`);
            setTimeout(() => tick(device).catch(() => {}), 1000);
          },
        }
        : {}),
      forget: async (device) => {
        asked.delete(device);
        announced.delete(device);
        await writer.forget(device);
      },
      setup: async (device) => {
        if (driver.check) {
          const attrs = (await cmd.sys.vfs.get(ADMIN_ACCESS, devicePath(device)).catch(() => undefined))?.attrs as DeviceAttrs | undefined;
          try {
            driver.check(attrs?.config ?? {});
          } catch (error) {
            throw new Error(
              `${driver.name} cannot ask ${device}: ${message(error)}; change its config with device-config ${device} name=value, or device-forget ${device}`,
            );
          }
        }
        setTimeout(() => tick(device).catch(() => {}), 0);
      },
    })
  );

  return {
    pollNow: (device) => setTimeout(() => tick(device).catch((error) => log(`polling ${device}: ${message(error)}`)), 0),
    stop: () => {
      stopped = true;
      clearInterval(timer);
      for (const each of unregister) each();
    },
  };
};
