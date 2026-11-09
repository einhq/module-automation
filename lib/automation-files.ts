/**
 * The automations' files: people's under `/etc/automations/<name>.yaml`, each run as its file's
 * owner, and modules' under `/etc/automations.d/<module>/<name>.yaml`, run as the administrator.
 *
 * A person's file anyone but its owner may write, by its mode or its access list, is not run:
 * whoever could change it would act as the owner. That is the rule sshd keeps for a key file, and
 * `chmod 644` is the way out.
 *
 * Whether one is on: a person's file's `enabled` attr, else its YAML's `enabled`. A module's file is
 * the module's and is replaced with it, so the administrator's choice for it is kept in the
 * `enabled` attr of `/etc/automations.d`, by name.
 */

import type { DeviceAttrs, EndpointAttrs } from '@ein/api';
import { type Access, ADMIN_ACCESS, type NodeProps, type NodeVFS, readTail, SYSTEM_TIME_ZONE, type UserAttrs, verifyAccess } from '@ein/client';
import { devicePath, USERS_PATH } from '@ein/paths';
import { parse } from '@std/yaml';
import type { AutomationProblem, AutomationSpec, AutomationValue } from './api.ts';
import type { LocalTime } from './automations/engine.ts';
import { type Automation, readAutomation } from './automations/graph.ts';
import { AUTOMATIONS_DIR, MODULE_AUTOMATIONS_DIR, MODULE_RUN_LOGS_DIR, MODULE_STATE_DIR, RUN_LOGS_DIR, STATE_DIR } from './paths.ts';

export type AutomationFile = {
  /** `<name>`, or `<module>/<name>`. */
  name: string;
  path: string;
  module?: string;
  /** Whose rights it runs with: its owner's, the administrator's for a module's. */
  owner: number;
  text: string;
  /** The YAML parsed, when it is YAML. */
  spec?: AutomationSpec;
  automation?: Automation;
  enabled: boolean;
  /** Why it is not run. */
  problems: AutomationProblem[];
};

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Whether `name` names an automation: `<name>` or `<module>/<name>`. */
export const isAutomationName = (name: string): boolean => {
  const parts = name.split('/');
  return parts.length <= 2 && parts.every((part) => NAME.test(part));
};

/** An automation's file: a name with a module in it is the module's. */
export const automationPath = (name: string): string => name.includes('/') ? `${MODULE_AUTOMATIONS_DIR}/${name}.yaml` : `${AUTOMATIONS_DIR}/${name}.yaml`;

/** An automation's name from its file's path, undefined for a path that holds no automation. */
export const automationName = (path: string): string | undefined => {
  for (const dir of [AUTOMATIONS_DIR, MODULE_AUTOMATIONS_DIR]) {
    if (!path.startsWith(`${dir}/`) || !path.endsWith('.yaml')) continue;
    const name = path.slice(dir.length + 1, -'.yaml'.length);
    if (isAutomationName(name) && (dir === MODULE_AUTOMATIONS_DIR) === name.includes('/')) return name;
  }
  return undefined;
};

/** An automation's run log, and where its deadlines are kept over a restart. */
export const runLogPath = (name: string): string => name.includes('/') ? `${MODULE_RUN_LOGS_DIR}/${name}` : `${RUN_LOGS_DIR}/${name}`;
export const statePath = (name: string): string => name.includes('/') ? `${MODULE_STATE_DIR}/${name}.json` : `${STATE_DIR}/${name}.json`;

/** Whether anyone but its owner may write a node: by its group or other bits, or an access list entry. */
const othersMayWrite = (props: NodeProps): boolean => {
  if ((props.mode & 0o022) !== 0) return true;
  return (props.acl ?? []).some((entry) => {
    if (entry.uid === props.uid) return false;
    const access: Access = { uid: entry.uid ?? -1, gid: entry.gid ?? -1, gids: entry.gid !== undefined ? [entry.gid] : [] };
    return verifyAccess(access, { uid: props.uid, gid: props.gid, mode: 0, acl: [entry] }, 'w');
  });
};

export const readText = async (vfs: NodeVFS, access: Access, path: string): Promise<string> => {
  const handle = await vfs.open(access, path, { mode: 'r' });
  try {
    return await new Response(handle.readable).text();
  } finally {
    await handle.close();
  }
};

const encoder = new TextEncoder();

/** Write `text` at `path`: a new file on the db tier, its owner's alone to change; an old one in place. */
export const writeText = async (vfs: NodeVFS, access: Access, path: string, text: string, mode = 0o644): Promise<boolean> => {
  const created = !(await vfs.exists(access, path));
  const bytes = encoder.encode(text);
  if (created) {
    const at = path.lastIndexOf('/');
    await vfs.create(access, 'file', path.slice(0, at) || '/', path.slice(at + 1), {
      props: { uid: access.uid, mode, tier: 'db' },
      attrs: { name: path.slice(at + 1), mimetype: path.endsWith('.json') ? 'application/json' : 'application/yaml', size: bytes.length },
    });
  }
  const handle = await vfs.open(access, path, { mode: 'w' });
  try {
    await handle.write(bytes);
  } finally {
    await handle.close();
  }
  return created;
};

/** The administrator's choices for modules' automations, by name: on or off, whatever the YAML says. */
export const moduleSwitches = async (vfs: NodeVFS): Promise<Record<string, boolean>> => {
  const node = await vfs.get<{ enabled?: Record<string, boolean> }>(ADMIN_ACCESS, MODULE_AUTOMATIONS_DIR).catch(() => undefined);
  return node?.attrs.enabled ?? {};
};

/** An automation's text read as YAML and checked, with what is wrong with it. */
export const parseAutomationText = (text: string): { spec?: AutomationSpec; automation?: Automation; problems: AutomationProblem[] } => {
  let raw: unknown;
  try {
    raw = parse(text) ?? {};
  } catch (error) {
    return { problems: [{ message: `it is not YAML: ${error instanceof Error ? error.message.split('\n')[0] : error}` }] };
  }
  const { automation, problems } = readAutomation(raw);
  return { spec: raw as AutomationSpec, automation, problems };
};

/** One automation's file, read as `access`. */
export const readAutomationFile = async (vfs: NodeVFS, access: Access, path: string, switches: Record<string, boolean> = {}): Promise<AutomationFile> => {
  const name = automationName(path);
  if (!name) throw new Error(`${path} is no automation's file: they are ${AUTOMATIONS_DIR}/<name>.yaml and ${MODULE_AUTOMATIONS_DIR}/<module>/<name>.yaml`);
  const module = name.includes('/') ? name.split('/')[0] : undefined;
  const node = await vfs.get<{ enabled?: boolean }>(access, path);
  const text = await readText(vfs, access, path);
  const { spec, automation, problems } = parseAutomationText(text);
  if (!module && othersMayWrite(node.props)) {
    problems.unshift({ message: 'others than its owner may change it, so it is not run (chmod 644, and no one else on its access list may write)' });
  }
  const own = module ? switches[name] : node.attrs.enabled;
  return {
    name,
    path,
    ...(module ? { module } : {}),
    owner: module ? ADMIN_ACCESS.uid : node.props.uid,
    text,
    ...(spec ? { spec } : {}),
    ...(automation ? { automation } : {}),
    enabled: typeof own === 'boolean' ? own : automation?.enabled ?? (spec as { enabled?: unknown } | undefined)?.enabled !== false,
    problems,
  };
};

const yamlChildren = async (vfs: NodeVFS, access: Access, dir: string): Promise<string[]> =>
  (await vfs.children(access, dir).catch(() => [])).filter((child) => child.name.endsWith('.yaml') && child.node.type === 'file').map((child) => `${dir}/${child.name}`);

/** Every automation's file `access` may read: people's, then modules', by name. */
const automationPaths = async (vfs: NodeVFS, access: Access): Promise<string[]> => {
  const own = await yamlChildren(vfs, access, AUTOMATIONS_DIR);
  const modules = await vfs.children(access, MODULE_AUTOMATIONS_DIR).catch(() => []);
  const theirs = (await Promise.all(modules.map((child) => yamlChildren(vfs, access, `${MODULE_AUTOMATIONS_DIR}/${child.name}`)))).flat();
  return [...own.sort(), ...theirs.sort()].filter((path) => automationName(path) !== undefined);
};

export const readAutomationFiles = async (vfs: NodeVFS, access: Access): Promise<AutomationFile[]> => {
  const switches = await moduleSwitches(vfs);
  const files: AutomationFile[] = [];
  for (const path of await automationPaths(vfs, access)) {
    try {
      files.push(await readAutomationFile(vfs, access, path, switches));
    } catch {
      // gone, or not readable, since it was listed
    }
  }
  return files;
};

/** An account's name by its uid, and its access: what an automation of its runs with. */
export const accounts = (vfs: NodeVFS) => {
  const names = new Map<number, string>();
  return {
    async nameOf(uid: number): Promise<string> {
      if (!names.has(uid)) {
        for (const entry of await vfs.children<UserAttrs>(ADMIN_ACCESS, USERS_PATH).catch(() => [])) {
          if (entry.node.type === 'user' && typeof entry.node.attrs.uid === 'number') names.set(entry.node.attrs.uid, entry.name);
        }
      }
      return names.get(uid) ?? String(uid);
    },
    forget(): void {
      names.clear();
    },
  };
};

/** What an account finds at an endpoint: whether it may read and write it, whether it holds presses, and its latest reading. */
type EndpointState = { readable: boolean; writable: boolean; events: boolean; value?: AutomationValue; at?: number };

export const endpointState = async (vfs: NodeVFS, access: Access, endpoint: string): Promise<EndpointState> => {
  const [device, name] = endpoint.split('/');
  const path = `${devicePath(device)}/${name}`;
  const node = await vfs.get<EndpointAttrs>(access, path).catch(() => undefined);
  if (!node || !verifyAccess(access, node.props, 'r')) {
    return { readable: false, writable: node ? verifyAccess(access, node.props, 'w') : false, events: false };
  }
  const state: EndpointState = { readable: true, writable: verifyAccess(access, node.props, 'w'), events: node.attrs.events === true };
  if (state.events) return state;
  const [last] = await readTail<{ value?: AutomationValue }>(vfs, access, path, 1).catch(() => []);
  const value = last?.value && typeof last.value === 'object' && 'value' in last.value ? last.value.value : undefined;
  return value === undefined ? state : { ...state, value, at: last.at };
};

/** Whether each device is online, as far as its driver said, read as `access`. */
export const onlineOf = async (vfs: NodeVFS, access: Access, devices: string[]): Promise<Map<string, boolean>> => {
  const online = new Map<string, boolean>();
  for (const device of devices) {
    const node = await vfs.get<DeviceAttrs>(access, devicePath(device)).catch(() => undefined);
    if (node && typeof node.attrs.online === 'boolean') online.set(device, node.attrs.online);
  }
  return online;
};

/** The day, the minute of the day and the weekday at `ms`, in the system's time zone. */
export const localTime = (ms: number): LocalTime => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SYSTEM_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    minute: Number(get('hour')) * 60 + Number(get('minute')),
    weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')),
  };
};
