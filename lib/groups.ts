/**
 * A group's id, which a service needs to give a node to a group: `group-info` answers it, since a
 * module reads no account files of its own.
 */

import type { Command } from '@ein/client';

/** The gid of the group `name`, or undefined when there is no such group. */
export const gidOf = async (cmd: Command, name: string): Promise<number | undefined> => {
  const { code, stdout } = await cmd.execute(`JSON_OUTPUT=1 group-info ${name}`).catch(() => ({ code: 1, stdout: '' }));
  if (code !== 0) return undefined;
  try {
    const gid = (JSON.parse(stdout) as { gid?: unknown }).gid;
    return typeof gid === 'number' ? gid : undefined;
  } catch {
    return undefined;
  }
};
