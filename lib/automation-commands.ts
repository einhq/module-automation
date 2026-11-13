/**
 * What automation's commands share: an automation named by its name or its file, as the caller
 * sees it, with whether the engine runs it.
 */

import { ADMIN_ACCESS, type Command, EVENTS_NODE_PATH, isAdmin, shq, verifyAccess } from '@ein/client';
import { parse, stringify } from '@std/yaml';
import type { AutomationCheck, AutomationDetail, AutomationNodeSpec, AutomationProblem, AutomationSpec, AutomationSummary, AutomationValue } from './api.ts';
import {
  accounts,
  type AutomationFile,
  automationName,
  automationPath,
  endpointState,
  folderReadable,
  isAutomationName,
  localTime,
  moduleSwitches,
  onlineOf,
  type parseAutomationText,
  readAutomationFile,
} from './automation-files.ts';
import { AutomationEngine, readsOf } from './automations/engine.ts';
import type { Example } from './automations/examples.ts';
import { canonicalSpec } from './automations/graph.ts';
import { placeNodes } from './automations/layout.ts';
import { engineState } from './state.ts';

/** The automation an argument names: `<name>`, `<module>/<name>`, or its file's path. */
export const resolveAutomation = (arg: string | undefined): { name: string; path: string } => {
  if (!arg) throw new Error('name an automation: <name>, <module>/<name>, or its file');
  if (arg.startsWith('/')) {
    const name = automationName(arg);
    if (!name) throw new Error(`${arg} is no automation's file: they are /etc/automations/<name>.yaml and /etc/automations.d/<module>/<name>.yaml`);
    return { name, path: arg };
  }
  const name = arg.replace(/\.yaml$/, '');
  if (!isAutomationName(name)) throw new Error(`${arg} is no automation's name: letters, digits, '.', '-' and '_'`);
  return { name, path: automationPath(name) };
};

/** An automation's file, read as the caller. */
export const readAs = async (cmd: Command, path: string): Promise<AutomationFile> =>
  await readAutomationFile(cmd.sys.vfs, cmd.access, path, path.includes('/automations.d/') ? await moduleSwitches(cmd.sys.vfs) : {});

/** Whether the caller may change an automation: its file, or for a module's, being the administrator. */
export const mayChange = async (cmd: Command, file: AutomationFile): Promise<boolean> => {
  if (file.module) return isAdmin(cmd.access);
  const node = await cmd.sys.vfs.get(cmd.access, file.path).catch(() => undefined);
  return node !== undefined && verifyAccess(cmd.access, node.props, 'w');
};

/** The problems the engine has with it beside its own: rights its owner lacks. */
const engineProblems = (name: string): AutomationProblem[] => engineState()?.known().get(name)?.problems ?? [];

export const summaryOf = async (cmd: Command, file: AutomationFile, names = accounts(cmd.sys.vfs)): Promise<AutomationSummary> => {
  const engine = engineState()?.known().get(file.name);
  const problems = file.problems.length ? file.problems : engineProblems(file.name);
  return {
    name: file.name,
    path: file.path,
    ...(file.module ? { module: file.module } : {}),
    owner: file.module ? 'admin' : await names.nameOf(file.owner),
    ...(file.spec?.description ? { description: String(file.spec.description) } : {}),
    enabled: file.enabled,
    running: engine?.running ?? false,
    nodes: file.spec?.nodes && typeof file.spec.nodes === 'object' ? Object.keys(file.spec.nodes).length : 0,
    problems,
    writable: await mayChange(cmd, file),
  };
};

/** The graph with every node placed: those without `pos` where the layout puts them. */
const placedSpec = (spec: AutomationSpec): AutomationSpec => {
  const nodes = spec.nodes && typeof spec.nodes === 'object' ? spec.nodes : {};
  const targets = (to: unknown): string[] => Array.isArray(to) ? to : to && typeof to === 'object' ? Object.values(to).flat() as string[] : [];
  const places = placeNodes(Object.entries(nodes).map(([id, node]) => ({ id, ...(node?.pos ? { pos: node.pos } : {}), targets: targets(node?.to) })));
  return { ...spec, nodes: Object.fromEntries(Object.entries(nodes).map(([id, node]) => [id, places.has(id) ? { ...node, pos: places.get(id)! } : node])) };
};

export const detailOf = async (cmd: Command, file: AutomationFile): Promise<AutomationDetail> => ({
  ...await summaryOf(cmd, file),
  text: file.text,
  ...(file.spec && typeof file.spec === 'object' ? { spec: placedSpec(file.spec) } : {}),
});

/** Turn an automation on or off: a person's by its file's attr, a module's in the administrator's switches. */
export const setEnabled = async (cmd: Command, file: AutomationFile, enabled: boolean): Promise<void> => {
  if (!(await mayChange(cmd, file))) {
    throw new Error(file.module ? `${file.name} is the ${file.module} module's: only the administrator turns it on or off` : `you may not change ${file.name}`);
  }
  if (file.module) {
    const switches = { ...await moduleSwitches(cmd.sys.vfs), [file.name]: enabled };
    await cmd.sys.vfs.update(ADMIN_ACCESS, '/etc/automations.d', { attrs: { enabled: switches } });
  } else {
    await cmd.sys.vfs.update(cmd.access, file.path, { attrs: { enabled } });
  }
  await engineState()?.reload();
};

/** Write a problem list as a person reads it. */
export const problemLines = (problems: AutomationProblem[]): string[] => problems.map((problem) => `  ${problem.node ? `${problem.node}: ` : ''}${problem.message}`);

/** A graph as YAML, each node on a line of its own. */
export const yamlOf = (spec: AutomationSpec): string => stringify(canonicalSpec(spec), { lineWidth: -1, flowLevel: 2 });

/**
 * What is wrong with an automation as the caller would run it, and what each of its nodes would say
 * now: the latest readings the caller may read sent through it, no action run. An endpoint the
 * caller may not read, a control they may not write, a folder they may not read, or an event they
 * may not raise is a problem, as it is for the engine when the caller owns it.
 */
export const checkAutomation = async (cmd: Command, read: ReturnType<typeof parseAutomationText>, name?: string): Promise<AutomationCheck> => {
  const problems = [...read.problems];
  const check: AutomationCheck = { ...(name ? { name } : {}), problems, nodes: {}, endpoints: [] };
  if (!read.automation) return check;
  const { endpoints, controls, devices, folders, raises } = readsOf(read.automation);
  for (const folder of folders) {
    if (!(await folderReadable(cmd.sys.vfs, cmd.access, folder))) problems.push({ message: `you may not read the folder ${folder}, or there is none` });
  }
  if (raises.length) {
    const events = await cmd.sys.vfs.get(ADMIN_ACCESS, EVENTS_NODE_PATH).catch(() => undefined);
    if (!events || !verifyAccess(cmd.access, events.props, 'w')) problems.push({ message: `you may not raise events: only the administrator writes ${EVENTS_NODE_PATH}` });
  }
  const values = new Map<string, { value: AutomationValue; at: number }>();
  for (const endpoint of new Set([...endpoints, ...controls])) {
    const state = await endpointState(cmd.sys.vfs, cmd.access, endpoint);
    if (endpoints.includes(endpoint) && !state.readable) problems.push({ message: `you may not read ${endpoint}, or there is no such endpoint` });
    if (controls.includes(endpoint) && !state.writable) problems.push({ message: `you may not write ${endpoint}, or there is no such control` });
    check.endpoints.push({
      endpoint,
      readable: state.readable,
      ...(state.value !== undefined ? { value: state.value } : {}),
      ...(state.at ? { at: new Date(state.at).toISOString() } : {}),
    });
    if (state.value !== undefined && state.at !== undefined) values.set(endpoint, { value: state.value, at: state.at });
  }
  const engine = new AutomationEngine(name ?? 'draft', read.automation, { schedule: () => () => {}, now: Date.now, localTime, act: () => Promise.resolve() });
  engine.prime({ values, online: await onlineOf(cmd.sys.vfs, cmd.access, devices) });
  check.nodes = engine.status();
  engine.stop();
  return check;
};

/** `<device>/<endpoint>`, also given as its path under /dev. */
const ENDPOINT = /^[^/\s]+\/[^/\s]+$/;

/**
 * A starting point with its slots filled from `<slot>=<value>` words. An endpoint may be given as
 * its path under /dev, a number is written as one, and `none` takes out the nodes the slot names,
 * with the wires into them, or else the fields it sets. The description is the one given, or the
 * starting point's own once a slot is set, since its YAML's names the stand-in devices. The
 * endpoint slots left unset are problems: their stand-ins are no household's devices.
 */
export const fillExample = (example: Example, sets: string[], description?: string): { spec: AutomationSpec; problems: AutomationProblem[] } => {
  const spec = parse(example.yaml) as AutomationSpec;
  const nodes = spec.nodes;
  const slots = example.slots ?? [];
  const given = new Set<string>();
  for (const word of sets) {
    const at = word.indexOf('=');
    const name = at < 0 ? word : word.slice(0, at);
    const slot = slots.find((each) => each.name === name);
    if (!slot) {
      throw new Error(
        slots.length ? `${example.name} has no slot ${name}; it has ${slots.map((each) => each.name).join(', ')}` : `${example.name} has no slots to set`,
      );
    }
    if (at < 0 || word.slice(at + 1).trim() === '') throw new Error(`--set ${name}=<value>: ${slot.about}`);
    if (given.has(name)) throw new Error(`${name} is set twice`);
    given.add(name);
    let value: string | number = word.slice(at + 1).trim();
    if (value === 'none') {
      if (slot.drops) {
        for (const id of slot.drops) delete nodes[id];
        const gone = new Set(slot.drops);
        for (const node of Object.values(nodes)) {
          if (Array.isArray(node.to)) node.to = node.to.filter((id) => !gone.has(id));
          else if (node.to) { for (const output of Object.keys(node.to)) node.to[output] = node.to[output].filter((id) => !gone.has(id)); }
        }
      } else {
        for (const field of slot.sets) delete nodes[field.split('.')[0]]?.[field.slice(field.indexOf('.') + 1)];
      }
      continue;
    }
    if (slot.kind === 'reading' || slot.kind === 'control') {
      value = value.replace(/^\/dev\//, '');
      if (!ENDPOINT.test(value)) throw new Error(`${name} takes <device>/<endpoint>, as device-show <device> lists them, not ${value}`);
    } else if (slot.kind === 'number') {
      if (!Number.isFinite(Number(value))) throw new Error(`${name} takes a number, not ${value}`);
      value = Number(value);
    }
    if (slot.line !== undefined) value = slot.line.replace('{}', shq(String(value)));
    for (const field of slot.sets) {
      const node: AutomationNodeSpec | undefined = nodes[field.split('.')[0]];
      if (node) node[field.slice(field.indexOf('.') + 1)] = value;
    }
  }
  if (description !== undefined) spec.description = description;
  else if (given.size) spec.description = example.description;
  const problems = given.size
    ? slots.filter((slot) => (slot.kind === 'reading' || slot.kind === 'control') && !given.has(slot.name))
      .map((slot) => ({ message: `${slot.name} is not set: --set ${slot.name}=<device>/<endpoint>${slot.drops ? ', or none' : ''}` }))
    : [];
  return { spec, problems };
};
