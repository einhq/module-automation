/**
 * The rule files under `/etc/automation/rules`: each `<name>.yaml` a rule, run as the file's owner.
 *
 * A file anyone but its owner may write is not run: whoever could change it would run its lines as
 * the owner. That is the rule sshd keeps for a key file, and `chmod 644` is the way out.
 */

import { type Command, readTail, SYSTEM_TIME_ZONE } from '@ein/client';
import { parse } from '@std/yaml';
import type { DeviceAttrs, Reading, Value } from './api.ts';
import { DEVICE_TYPE, DEVICES_ROOT, entityPath, HISTORY_NAME, RULES_DIR } from './paths.ts';
import { entitiesOf, type Rule, ruleFrom } from './rules.ts';

export type RuleFile = {
  name: string;
  path: string;
  /** Whose rights the rule's lines run with. */
  owner: number;
  rule?: Rule;
  /** Why it is not run. */
  problem?: string;
};

const readText = async (cmd: Command, path: string): Promise<string> => {
  const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
  try {
    return await new Response(handle.readable).text();
  } finally {
    await handle.close();
  }
};

/** One rule file, read as the command's caller. */
export const readRuleFile = async (cmd: Command, path: string): Promise<RuleFile> => {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.yaml$/, '');
  const node = await cmd.sys.vfs.get(cmd.access, path);
  const file: RuleFile = { name, path, owner: node.props.uid };
  if ((node.props.mode & 0o022) !== 0) {
    return { ...file, problem: 'others than its owner may change it, so it is not run (chmod 644)' };
  }
  try {
    return { ...file, rule: ruleFrom(name, parse(await readText(cmd, path))) };
  } catch (error) {
    return { ...file, problem: error instanceof Error ? error.message : String(error) };
  }
};

/** Every rule file, by name. */
export const readRuleFiles = async (cmd: Command): Promise<RuleFile[]> => {
  const children = await cmd.sys.vfs.children(cmd.access, RULES_DIR).catch(() => []);
  const names = children.filter((child) => child.name.endsWith('.yaml') && child.node.type === 'file').map((child) => child.name).sort();
  return await Promise.all(names.map((name) => readRuleFile(cmd, `${RULES_DIR}/${name}`)));
};

/** The latest value of each entity the rules read, from their histories, by `<device>/<entity>`. */
export const latestValues = async (cmd: Command, rules: Rule[]): Promise<Map<string, Value>> => {
  const values = new Map<string, Value>();
  for (const key of new Set(rules.flatMap(entitiesOf))) {
    const [device, entity] = key.split('/');
    const [last] = await readTail<Reading>(cmd.sys.vfs, cmd.access, `${entityPath(device, entity)}/${HISTORY_NAME}`, 1);
    if (last?.value && typeof last.value === 'object' && 'value' in last.value) values.set(key, last.value.value);
  }
  return values;
};

/** Whether each device is online, as far as it said. */
export const onlineDevices = async (cmd: Command): Promise<Map<string, boolean>> => {
  const online = new Map<string, boolean>();
  const children = await cmd.sys.vfs.children<DeviceAttrs>(cmd.access, DEVICES_ROOT).catch(() => []);
  for (const child of children) {
    if (child.node.type === DEVICE_TYPE && typeof child.node.attrs.online === 'boolean') online.set(child.name, child.node.attrs.online);
  }
  return online;
};

/** The day and the minute of the day at `ms`, in the system's time zone. */
export const localTime = (ms: number): { day: string; minute: number } => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SYSTEM_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, minute: Number(get('hour')) * 60 + Number(get('minute')) };
};
