/**
 * What the commands about hosts on the network share: who may use them, the devices under /dev to
 * match hosts to, and the hosts no one wants as devices.
 */

import { type DeviceAttrs, deviceName, DEVICES_GROUPNAME } from '@ein/api';
import { ADMIN_ACCESS, type Command, isAdmin } from '@ein/client';
import { DEV_PATH, DEV_RESERVED_NAMES, devicePath } from '@ein/paths';
import type { FoundAnswer, FoundDetail } from '../api.ts';
import { gidOf } from '../groups.ts';
import { NETWORK_IGNORED } from '../paths.ts';
import { bridgeState } from '../state.ts';
import { foundDevices, type KnownDevice } from './found.ts';
import { webPageOf } from './identify.ts';

export { adoptShelly } from './adopt.ts';
export { answersSnmp, createPolledDrivers, DEFAULT_COMMUNITY, POLLED_DRIVERS } from './polled.ts';
export { snmpWalk } from './snmp.ts';

/**
 * Throws unless the caller makes devices: the administrator or a member of the devices group. What
 * is on the network, with its addresses, is theirs to see.
 */
export const assertDevicesMember = async (cmd: Command): Promise<void> => {
  if (isAdmin(cmd.access)) return;
  const gid = await gidOf(cmd, DEVICES_GROUPNAME);
  if (gid === undefined || !cmd.access.gids.includes(gid)) throw new Error(`only the ${DEVICES_GROUPNAME} group's members see and add the devices on the network`);
};

/** Every device under /dev, whoever may read it, by name and hardware address. */
const knownDevices = async (cmd: Command): Promise<KnownDevice[]> => {
  const children = await cmd.sys.vfs.children<DeviceAttrs>(ADMIN_ACCESS, DEV_PATH).catch(() => []);
  return children.filter((child) => child.node.type === 'device').map((child) => ({
    name: child.name,
    ...(child.node.attrs.mac ? { mac: child.node.attrs.mac } : {}),
    ...(child.node.attrs.config?.found ? { found: child.node.attrs.config.found } : {}),
  }));
};

/** The ids of the hosts no one wants as devices. */
export const readIgnored = async (cmd: Command): Promise<Set<string>> => {
  try {
    const handle = await cmd.sys.vfs.open(ADMIN_ACCESS, NETWORK_IGNORED, { mode: 'r' });
    try {
      return new Set((await new Response(handle.readable).text()).split('\n').map((line) => line.trim()).filter(Boolean));
    } finally {
      await handle.close();
    }
  } catch {
    return new Set();
  }
};

export const writeIgnored = async (cmd: Command, ids: Set<string>): Promise<void> => {
  const at = NETWORK_IGNORED.lastIndexOf('/');
  await cmd.sys.vfs.ensure(ADMIN_ACCESS, 'file', NETWORK_IGNORED.slice(0, at), NETWORK_IGNORED.slice(at + 1), { props: { mode: 0o644 } });
  const handle = await cmd.sys.vfs.open(ADMIN_ACCESS, NETWORK_IGNORED, { mode: 'w' });
  try {
    await handle.write(new TextEncoder().encode([...ids].sort().map((id) => `${id}\n`).join('')));
  } finally {
    await handle.close();
  }
};

/** What the running bridge heard of the network; undefined when no bridge runs in this process. */
export const readFound = async (cmd: Command): Promise<FoundAnswer | undefined> => {
  const network = bridgeState()?.network;
  if (!network) return undefined;
  const [devices, ignored] = await Promise.all([knownDevices(cmd), readIgnored(cmd)]);
  return foundDevices(network, devices, ignored);
};

/** One host the running bridge heard, by its id or address, with all it said; undefined when none is. */
export const readFoundDetail = async (cmd: Command, id: string): Promise<FoundDetail | undefined> => {
  const network = bridgeState()?.network;
  const found = await readFound(cmd);
  const device = found?.devices.find((each) => each.id === id || each.ip === id);
  const host = device && network?.hosts.get(device.id);
  return device && host ? { ...device, host } : undefined;
};

/**
 * Makes `found` a device of a polled driver (`network`, `ipp`, `snmp`, `cast`) under /dev, named
 * after its label, as the administrator, since /dev is theirs. It keeps the host's id, so it follows
 * the host to a new address, and what its driver asks with: a printer's IPP port and resource, the
 * SNMP community. Answers the device's name.
 */
export const addPolledDevice = async (cmd: Command, found: FoundDetail, driver: string, community?: string): Promise<string> => {
  const manager = cmd.sys.devices;
  if (!manager) throw new Error('devices are not running here');
  const base = deviceName(found.label) || deviceName(found.id) || 'device';
  let name = base;
  for (let n = 2; DEV_RESERVED_NAMES.includes(name) || await cmd.sys.vfs.exists(ADMIN_ACCESS, devicePath(name)); n++) name = `${base}-${n}`;
  const ipp = found.host.mdns.find((each) => each.type === '_ipp._tcp');
  const config: Record<string, string> = {
    found: found.id,
    ip: found.ip,
    ...(driver === 'ipp' && ipp?.port ? { port: String(ipp.port) } : {}),
    ...(driver === 'ipp' && ipp?.txt.rp ? { path: ipp.txt.rp } : {}),
    ...(driver === 'snmp' && community ? { community } : {}),
  };
  const attrs: DeviceAttrs = {
    label: found.label,
    driver,
    ...(found.class ? { class: found.class } : {}),
    ...(found.vendor ? { manufacturer: found.vendor } : {}),
    ...(found.model ? { model: found.model } : {}),
    ...(found.firmware ? { firmware: found.firmware } : {}),
    ...(found.serial ? { serial: found.serial } : {}),
    ...(found.mac ? { mac: found.mac } : {}),
    ...(webPageOf(found.host) ? { url: webPageOf(found.host) } : {}),
    config,
  };
  await manager.ensureDevice(ADMIN_ACCESS, name, attrs);
  bridgeState()?.pollNow?.(name);
  return name;
};
