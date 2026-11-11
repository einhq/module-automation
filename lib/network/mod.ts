/**
 * What the commands about hosts on the network share: who may use them, the devices under /dev to
 * match hosts to, and the hosts no one wants as devices.
 */

import { type DeviceAttrs, deviceName, DEVICES_GROUPNAME } from '@ein/api';
import { ADMIN_ACCESS, type Command, isAdmin, shq } from '@ein/client';
import { DEV_PATH, DEV_RESERVED_NAMES, devicePath } from '@ein/paths';
import type { FoundAnswer, FoundDetail } from '../api.ts';
import { ONVIF_DRIVER } from '../cameras/onvif-driver.ts';
import { createOnvif } from '../cameras/onvif.ts';
import { gidOf } from '../groups.ts';
import { NETWORK_IGNORED } from '../paths.ts';
import { bridgeState } from '../state.ts';
import type { Fetch } from './adopt.ts';
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
  const dir = NETWORK_IGNORED.slice(0, at);
  await cmd.sys.vfs.ensure(ADMIN_ACCESS, 'directory', dir.slice(0, dir.lastIndexOf('/')) || '/', dir.slice(dir.lastIndexOf('/') + 1), { props: { mode: 0o755 } });
  await cmd.sys.vfs.ensure(ADMIN_ACCESS, 'file', dir, NETWORK_IGNORED.slice(at + 1), { props: { mode: 0o644 } });
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

/** A name under /dev for `found`, made from its label, that no device has. */
const freeName = async (cmd: Command, found: FoundDetail): Promise<string> => {
  const base = deviceName(found.label) || deviceName(found.id) || 'device';
  let name = base;
  for (let n = 2; DEV_RESERVED_NAMES.includes(name) || await cmd.sys.vfs.exists(ADMIN_ACCESS, devicePath(name)); n++) name = `${base}-${n}`;
  return name;
};

/**
 * Makes the ONVIF camera `found` a device of the `onvif` driver, once it has taken `user` and
 * `password`: through `device-create`, run as the caller, which keeps the password in the device's
 * secret. The camera's device service is asked at the address it was found at, and keeps the host's
 * id, so it follows the camera to a new address. Answers the device's name.
 */
export const addOnvifCamera = async (cmd: Command, found: FoundDetail, user: string, password: string, fetcher: Fetch = fetch): Promise<string> => {
  const manager = cmd.sys.devices;
  if (!manager) throw new Error('devices are not running here');
  const xaddrs = found.host.wsd.flatMap((each) => each.xaddrs).filter((xaddr) => /^https?:\/\//i.test(xaddr));
  const xaddr = xaddrs.find((each) => new URL(each).hostname === found.ip) ?? xaddrs[0];
  if (!xaddr) throw new Error(`${found.label} named no address for its ONVIF service`);
  const address = new URL(xaddr);
  address.hostname = found.ip;
  const info = await createOnvif(fetcher, address.toString(), user, password).info();
  const name = await freeName(cmd, found);
  const config = { address: address.toString(), found: found.id, ...(user ? { user } : {}), ...(password ? { password } : {}) };
  const script = [
    'device-create',
    shq(name),
    `--label ${shq(found.label)}`,
    `--driver ${ONVIF_DRIVER}`,
    '--class camera',
    ...(info.manufacturer ?? found.vendor ? [`--manufacturer ${shq((info.manufacturer ?? found.vendor)!)}`] : []),
    ...(info.model ?? found.model ? [`--model ${shq((info.model ?? found.model)!)}`] : []),
    ...Object.entries(config).map(([key, value]) => `--config ${shq(`${key}=${value}`)}`),
  ].join(' ');
  const made = await cmd.execute(script);
  if (made.code !== 0) throw new Error(made.stderr.trim().replace(/^device-create: /, '') || 'device-create failed');
  const url = webPageOf(found.host) ?? `http://${found.ip}/`;
  await manager.ensureDevice(ADMIN_ACCESS, name, {
    url,
    ...(info.firmware ? { firmware: info.firmware } : {}),
    ...(info.serial ? { serial: info.serial } : {}),
    ...(found.mac ? { mac: found.mac } : {}),
  });
  return name;
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
  const name = await freeName(cmd, found);
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
