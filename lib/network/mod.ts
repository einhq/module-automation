/**
 * What the commands about hosts on the network share: who may use them, the devices under /dev to
 * match hosts to, and the hosts no one wants as devices.
 */

import { type DeviceAttrs, DEVICES_GROUPNAME } from '@ein/api';
import { ADMIN_ACCESS, type Command, isAdmin } from '@ein/client';
import { DEV_PATH } from '@ein/paths';
import type { FoundAnswer } from '../api.ts';
import { gidOf } from '../groups.ts';
import { NETWORK_IGNORED } from '../paths.ts';
import { bridgeState } from '../state.ts';
import { foundDevices, type KnownDevice } from './found.ts';

export { adoptShelly } from './adopt.ts';

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
  return children.filter((child) => child.node.type === 'device').map((child) => ({ name: child.name, ...(child.node.attrs.mac ? { mac: child.node.attrs.mac } : {}) }));
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
