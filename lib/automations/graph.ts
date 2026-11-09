/**
 * An automation from its YAML: each node checked against its kind in the catalog, its settings read
 * into what the engine uses (durations in milliseconds, times as minutes of the day), its wires
 * checked, and the graph refused when its wires go round in a circle.
 *
 *   description: Hall light on motion when dark
 *   nodes:
 *     motion: {type: device, endpoint: hall-sensor/motion, to: [linger]}
 *     linger: {type: timer, off-after: 5m, to: {true: [lamp-on], false: [lamp-off]}}
 *     lamp-on: {type: control, endpoint: hall-lamp/switch-0, value: on, pos: [440, 0]}
 *
 * Import-free but for its own module's files, so the editor checks a graph as it is drawn.
 */

import type { AutomationNodeSpec, AutomationProblem, AutomationSpec, AutomationValue as Value } from '../api.ts';
import { COMMON_KEYS, KINDS, type KindSpec, type SettingSpec } from './catalog.ts';
import { type Expression, namesIn, parseExpression } from './math.ts';
import type { Test } from './values.ts';
import { parseDuration } from '../time.ts';

/** The most nodes an automation has. */
const MAX_NODES = 200;

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DAY_NAMES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const FULL_DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** A setting as the engine reads it. */
type Setting = Value | number[] | Expression | { name: string; test: Test }[];

export type Node = {
  id: string;
  type: string;
  kind: KindSpec;
  label?: string;
  pos?: [number, number];
  /** Its settings as written. */
  spec: AutomationNodeSpec;
  /** Its settings as the engine reads them. */
  config: Record<string, Setting | undefined>;
  /** The nodes each output sends to. */
  wires: Record<string, string[]>;
  /** The outputs it has: its kind's, and a switch's cases. */
  outputs: string[];
};

export type Automation = {
  description?: string;
  enabled: boolean;
  nodes: Map<string, Node>;
  /** The nodes wired into each node. */
  senders: Map<string, string[]>;
};

type Mapping = Record<string, unknown>;

const isMapping = (value: unknown): value is Mapping => value !== null && typeof value === 'object' && !Array.isArray(value);

const isScalar = (value: unknown): value is Value => value === null || ['string', 'number', 'boolean'].includes(typeof value);

/** A name an expression reads a sender's value by: its id with dashes as underscores. */
export const nameOfSender = (id: string): string => id.replaceAll('-', '_');

const parseTime = (value: unknown): number => {
  const match = typeof value === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(value.trim()) : null;
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error(`takes a time of day such as "07:30", not ${JSON.stringify(value)}`);
  return Number(match[1]) * 60 + Number(match[2]);
};

/** Days of the week as numbers, Monday 0. */
const parseDays = (value: unknown): number[] => {
  const words = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : undefined;
  if (!words?.length) throw new Error('takes days such as weekdays, weekends or [mon, wed, fri]');
  const days = new Set<number>();
  for (const raw of words) {
    const word = String(raw).trim().toLowerCase();
    const day = DAY_NAMES.findIndex((name, index) => word === name || word === FULL_DAY_NAMES[index]);
    if (word === 'weekdays') [0, 1, 2, 3, 4].forEach((each) => days.add(each));
    else if (word === 'weekends') [5, 6].forEach((each) => days.add(each));
    else if (day >= 0) days.add(day);
    else throw new Error(`takes days such as mon, tue or weekdays, not ${JSON.stringify(raw)}`);
  }
  return [...days].sort();
};

const parseTest = (raw: unknown): Test => {
  if (!isMapping(raw)) throw new Error('takes is, not, above or below, such as {below: 18}');
  const test: Test = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'is' || key === 'not') {
      if (!isScalar(value)) throw new Error(`${key} takes a value, not ${JSON.stringify(value)}`);
      test[key] = value;
    } else if (key === 'above' || key === 'below') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} takes a number, not ${JSON.stringify(value)}`);
      test[key] = value;
    } else throw new Error(`has ${key}; a case takes is, not, above or below`);
  }
  if (Object.keys(test).length === 0) throw new Error('says nothing to meet: give it is, not, above or below');
  return test;
};

const readSetting = (spec: SettingSpec, value: unknown): Setting => {
  switch (spec.type) {
    case 'endpoint': {
      const parts = typeof value === 'string' ? value.split('/') : [];
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`takes <device>/<endpoint>, not ${JSON.stringify(value)}`);
      return value as string;
    }
    case 'device':
    case 'text':
    case 'line':
      if (typeof value !== 'string' || !value.trim()) throw new Error(`takes text, not ${JSON.stringify(value)}`);
      return value;
    case 'duration': {
      const ms = typeof value === 'string' ? parseDuration(value) : undefined;
      if (ms === undefined || ms <= 0) throw new Error(`takes a duration such as 30s, 5m or 1h, not ${JSON.stringify(value)}`);
      return ms;
    }
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`takes a number, not ${JSON.stringify(value)}`);
      return value;
    case 'value':
      if (!isScalar(value)) throw new Error(`takes a value, not ${JSON.stringify(value)}`);
      return value;
    case 'time':
      return parseTime(value);
    case 'days':
      return parseDays(value);
    case 'flag':
      if (typeof value !== 'boolean') throw new Error(`takes true or false, not ${JSON.stringify(value)}`);
      return value;
    case 'choice':
      if (typeof value !== 'string' || !spec.choices?.includes(value)) throw new Error(`takes one of ${spec.choices?.join(', ')}, not ${JSON.stringify(value)}`);
      return value;
    case 'expression':
      if (typeof value !== 'string') throw new Error(`takes an expression, not ${JSON.stringify(value)}`);
      return parseExpression(value);
    case 'cases': {
      if (!isMapping(value) || Object.keys(value).length === 0) throw new Error('takes named cases, such as {cold: {below: 18}, warm: {above: 23}}');
      return Object.entries(value).map(([name, test]) => {
        if (!ID.test(name) || name === 'else') throw new Error(`has a case named ${JSON.stringify(name)}; a case is named with letters, digits, - and _, and not else`);
        try {
          return { name, test: parseTest(test) };
        } catch (error) {
          throw new Error(`${name} ${error instanceof Error ? error.message : error}`);
        }
      });
    }
  }
};

/** What a node's kind asks beyond each setting on its own. */
const checkKind = (kind: KindSpec, config: Node['config']): string | undefined => {
  if (kind.type === 'clock' && (config.at === undefined) === (config.every === undefined)) return 'a clock takes at or every, one of them';
  if (kind.type === 'clock' && config.every !== undefined && (config.every as number) < 60_000) return 'every takes a minute or more';
  if (kind.type === 'clock' && config.every !== undefined && config.days !== undefined) return 'days go with at, not with every';
  if (kind.type === 'compare' && !['is', 'not', 'above', 'below'].some((key) => config[key] !== undefined)) return 'a compare takes is, not, above or below';
  return undefined;
};

const readWires = (raw: unknown, outputs: string[]): Record<string, string[]> => {
  if (raw === undefined) return {};
  const list = (value: unknown, output: string): string[] => {
    const ids = typeof value === 'string' ? [value] : Array.isArray(value) ? value : undefined;
    if (!ids || ids.some((id) => typeof id !== 'string')) throw new Error(`to${output === 'out' ? '' : `.${output}`} takes node ids`);
    return [...new Set(ids as string[])];
  };
  if (!isMapping(raw)) {
    if (!outputs.includes('out')) throw new Error(`sends on ${outputs.join(', ') || 'nothing'}, so to takes those by name`);
    return { out: list(raw, 'out') };
  }
  const wires: Record<string, string[]> = {};
  for (const [output, value] of Object.entries(raw)) {
    if (!outputs.includes(output)) throw new Error(`has no output ${output}; it has ${outputs.join(', ') || 'none'}`);
    wires[output] = list(value, output);
  }
  return wires;
};

const readNode = (id: string, raw: unknown): Node => {
  if (!isMapping(raw)) throw new Error('a node is a mapping with a type');
  const kind = typeof raw.type === 'string' ? KINDS[raw.type] : undefined;
  if (!kind) throw new Error(`type ${JSON.stringify(raw.type)} is no kind of node; there are ${Object.keys(KINDS).join(', ')}`);
  const known = new Set<string>([...COMMON_KEYS, ...kind.settings.map((setting) => setting.name)]);
  const unknown = Object.keys(raw).filter((key) => !known.has(key));
  if (unknown.length) throw new Error(`${unknown.join(', ')}: a ${kind.type} node does not read ${unknown.length > 1 ? 'these' : 'this'}`);
  const config: Node['config'] = {};
  for (const setting of kind.settings) {
    const value = raw[setting.name];
    if (value === undefined || value === null) {
      if (setting.required) throw new Error(`${setting.name} is needed: ${setting.label.toLowerCase()}`);
      continue;
    }
    try {
      config[setting.name] = readSetting(setting, value);
    } catch (error) {
      throw new Error(`${setting.name} ${error instanceof Error ? error.message : error}`);
    }
  }
  const problem = checkKind(kind, config);
  if (problem) throw new Error(problem);
  if (raw.label !== undefined && typeof raw.label !== 'string') throw new Error('label takes text');
  const pos = raw.pos;
  if (pos !== undefined && !(Array.isArray(pos) && pos.length === 2 && pos.every((n) => typeof n === 'number' && Number.isFinite(n)))) throw new Error('pos takes [x, y]');
  const outputs = kind.type === 'switch' ? [...(config.cases as { name: string }[]).map((each) => each.name), 'else'] : [...kind.outputs];
  return {
    id,
    type: kind.type,
    kind,
    ...(typeof raw.label === 'string' && raw.label ? { label: raw.label } : {}),
    ...(pos ? { pos: pos as [number, number] } : {}),
    spec: raw as AutomationNodeSpec,
    config,
    wires: readWires(raw.to, outputs),
    outputs,
  };
};

/** The ids on a circle of wires, if there is one. */
const findCycle = (nodes: Map<string, Node>): string[] | undefined => {
  const state = new Map<string, 'open' | 'done'>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'done') return undefined;
    if (state.get(id) === 'open') return [...path.slice(path.indexOf(id)), id];
    state.set(id, 'open');
    path.push(id);
    for (const target of Object.values(nodes.get(id)?.wires ?? {}).flat()) {
      const cycle = visit(target);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, 'done');
    return undefined;
  };
  for (const id of nodes.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return undefined;
};

/**
 * An automation from its parsed YAML, and everything wrong with it, each problem with its node. An
 * automation with problems is not run; the editor shows them where they are.
 */
export const readAutomation = (raw: unknown): { automation?: Automation; problems: AutomationProblem[] } => {
  if (!isMapping(raw)) return { problems: [{ message: 'an automation is a mapping with nodes' }] };
  const problems: AutomationProblem[] = [];
  const extra = Object.keys(raw).filter((key) => !['description', 'enabled', 'nodes'].includes(key));
  if (extra.length) problems.push({ message: `${extra.join(', ')}: an automation has description, enabled and nodes` });
  if (raw.description !== undefined && typeof raw.description !== 'string') problems.push({ message: 'description takes text' });
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') problems.push({ message: 'enabled takes true or false' });
  if (!isMapping(raw.nodes)) return { problems: [...problems, { message: 'nodes takes the nodes by id, such as {motion: {type: device, endpoint: hall-sensor/motion}}' }] };
  const entries = Object.entries(raw.nodes);
  if (entries.length > MAX_NODES) problems.push({ message: `it has ${entries.length} nodes; an automation has at most ${MAX_NODES}` });

  const nodes = new Map<string, Node>();
  for (const [id, spec] of entries) {
    if (!ID.test(id)) {
      problems.push({ node: id, message: 'a node id is letters, digits, - and _, starting with a letter or digit' });
      continue;
    }
    try {
      nodes.set(id, readNode(id, spec));
    } catch (error) {
      problems.push({ node: id, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const senders = new Map<string, string[]>();
  for (const node of nodes.values()) {
    for (const [output, targets] of Object.entries(node.wires)) {
      for (const target of targets) {
        const to = nodes.get(target);
        if (!to) {
          if (!(target in (raw.nodes as Mapping))) problems.push({ node: node.id, message: `${output === 'out' ? 'to' : `to.${output}`} names ${target}, which is no node` });
          continue;
        }
        if (!to.kind.input) problems.push({ node: node.id, message: `${target} is a ${to.type} node, which nothing is wired into` });
        else if (target === node.id) problems.push({ node: node.id, message: 'it is wired into itself' });
        else if (!senders.get(target)?.includes(node.id)) senders.set(target, [...senders.get(target) ?? [], node.id]);
      }
    }
  }
  for (const node of nodes.values()) {
    if (node.type !== 'math') continue;
    const known = new Set(['value', 'topic', ...(senders.get(node.id) ?? []).map(nameOfSender)]);
    const unknown = namesIn(node.config.expression as Expression).filter((name) => !known.has(name));
    if (unknown.length) problems.push({ node: node.id, message: `expression reads ${unknown.join(', ')}; it knows value, topic and the nodes wired into it` });
  }
  const cycle = problems.length ? undefined : findCycle(nodes);
  if (cycle) problems.push({ node: cycle[0], message: `its wires go round in a circle: ${cycle.join(' → ')}` });

  if (problems.length) return { problems };
  return {
    automation: {
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      enabled: raw.enabled !== false,
      nodes,
      senders,
    },
    problems,
  };
};

/**
 * An automation as its YAML is written from the editor: each node's type and label first, its
 * settings in its kind's order, then where it is and where it sends. Unknown keys are kept where the
 * node has them, so a draft with problems is written as it is.
 */
export const canonicalSpec = (spec: AutomationSpec): AutomationSpec => {
  const nodes: Record<string, AutomationNodeSpec> = {};
  for (const [id, node] of Object.entries(spec.nodes ?? {})) {
    const kind = KINDS[node.type];
    const order = ['type', 'label', ...(kind?.settings.map((setting) => setting.name) ?? [])];
    const out: Record<string, unknown> = {};
    for (const key of order) if (node[key] !== undefined && node[key] !== '') out[key] = node[key];
    for (const [key, value] of Object.entries(node)) if (!(key in out) && key !== 'pos' && key !== 'to' && value !== undefined) out[key] = value;
    if (node.pos) out.pos = node.pos.map((n) => Math.round(n));
    const wires: Record<string, string[]> = Array.isArray(node.to) ? { out: node.to } : { ...node.to ?? {} };
    const outputs = Object.keys(wires).filter((output) => wires[output]?.length);
    if (outputs.length === 1 && outputs[0] === 'out') out.to = wires.out;
    else if (outputs.length) out.to = Object.fromEntries(outputs.map((output) => [output, wires[output]]));
    nodes[id] = out as AutomationNodeSpec;
  }
  return {
    ...(spec.description ? { description: spec.description } : {}),
    ...(spec.enabled === false ? { enabled: false } : {}),
    nodes,
  };
};

/**
 * What decides how an automation runs, without where its nodes are or what they are called: two
 * automations with the same fingerprint run alike, so moving a node keeps its timers running.
 */
export const fingerprint = (spec: AutomationSpec): string => {
  const nodes = Object.entries(canonicalSpec(spec).nodes).map(([id, node]) => {
    const { pos: _pos, label: _label, ...rest } = node;
    return [id, rest];
  });
  return JSON.stringify({ enabled: spec.enabled !== false, nodes });
};
