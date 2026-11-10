/**
 * The editor's changes to an automation's graph, each a new graph: nodes added, moved, set and
 * removed, wires drawn and taken out. What a node sends on, and the wires as a list, read from the
 * same YAML shape the file has. Pure, so it is tested without a page.
 */

import type { AutomationNodeSpec, AutomationSpec } from '../../lib/api.ts';
import { KINDS } from '../../lib/automations/catalog.ts';
import { nameOfSender } from '../../lib/automations/graph.ts';

export type Wire = { from: string; output: string; to: string };

type Pos = [number, number];

const isMapping = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A node's wires by output, a list for `out` read as such. */
const wiresBy = (node: AutomationNodeSpec): Record<string, string[]> => {
  if (Array.isArray(node.to)) return { out: node.to.map(String) };
  if (!isMapping(node.to)) return {};
  return Object.fromEntries(Object.entries(node.to).map(([output, ids]) => [output, Array.isArray(ids) ? ids.map(String) : typeof ids === 'string' ? [ids] : []]));
};

/** Wires by output as the file writes them: a list when they all leave from `out`. */
const toOf = (wires: Record<string, string[]>): AutomationNodeSpec['to'] | undefined => {
  const used = Object.entries(wires).filter(([, ids]) => ids.length);
  if (!used.length) return undefined;
  if (used.length === 1 && used[0][0] === 'out') return used[0][1];
  return Object.fromEntries(used);
};

const withNode = (spec: AutomationSpec, id: string, node: AutomationNodeSpec): AutomationSpec => ({ ...spec, nodes: { ...spec.nodes, [id]: node } });

const withWires = (node: AutomationNodeSpec, wires: Record<string, string[]>): AutomationNodeSpec => {
  const { to: _to, ...rest } = node;
  const to = toOf(wires);
  return to ? { ...rest, to } : rest;
};

/** The outputs a node sends on: its kind's, and a switch's cases before `else`. */
export const outputsOf = (node: AutomationNodeSpec): string[] => {
  const kind = KINDS[node.type];
  if (!kind) return ['out'];
  if (kind.type === 'switch') return [...(isMapping(node.cases) ? Object.keys(node.cases) : []), 'else'];
  return [...kind.outputs];
};

/** Whether wires may come into a node. */
export const takesInput = (node: AutomationNodeSpec | undefined): boolean => node !== undefined && (KINDS[node.type]?.input ?? true);

export const wiresOf = (spec: AutomationSpec): Wire[] =>
  Object.entries(spec.nodes).flatMap(([from, node]) =>
    Object.entries(wiresBy(node)).flatMap(([output, ids]) => ids.filter((to) => to in spec.nodes).map((to) => ({ from, output, to })))
  );

/** Whether a wire from `from` to `to` would bring a node's messages back round to it. */
export const wouldCycle = (spec: AutomationSpec, from: string, to: string): boolean => {
  if (from === to) return true;
  const next = new Map<string, string[]>();
  for (const wire of wiresOf(spec)) next.set(wire.from, [...next.get(wire.from) ?? [], wire.to]);
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const at = stack.pop()!;
    if (at === from) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    stack.push(...next.get(at) ?? []);
  }
  return false;
};

/** The graph with `wire` in it; the same graph when it is there, goes nowhere a wire may, or would go round. */
export const connect = (spec: AutomationSpec, wire: Wire): AutomationSpec => {
  const from = spec.nodes[wire.from];
  if (!from || !takesInput(spec.nodes[wire.to]) || !outputsOf(from).includes(wire.output) || wouldCycle(spec, wire.from, wire.to)) return spec;
  const wires = wiresBy(from);
  if (wires[wire.output]?.includes(wire.to)) return spec;
  return withNode(spec, wire.from, withWires(from, { ...wires, [wire.output]: [...wires[wire.output] ?? [], wire.to] }));
};

export const disconnect = (spec: AutomationSpec, wire: Wire): AutomationSpec => {
  const from = spec.nodes[wire.from];
  if (!from) return spec;
  const wires = wiresBy(from);
  return withNode(spec, wire.from, withWires(from, { ...wires, [wire.output]: (wires[wire.output] ?? []).filter((id) => id !== wire.to) }));
};

/** A new node of `type` at `pos`, named after its kind: `delay`, then `delay-2`. */
export const addNode = (spec: AutomationSpec, type: string, pos: Pos): { spec: AutomationSpec; id: string } => {
  let id = type;
  for (let n = 2; id in spec.nodes; n++) id = `${type}-${n}`;
  return { spec: withNode(spec, id, { type, pos }), id };
};

/** Why `to` cannot name a node of `spec`, or undefined when it can: the rules the YAML's ids have. */
export const nameProblem = (spec: AutomationSpec, to: string): string | undefined => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(to)) return 'Letters, digits, - and _, starting with a letter or digit';
  if (to in spec.nodes) return `${to} names another node`;
  return undefined;
};

/**
 * The graph with node `from` named `to`, in its place among the others: the wires into it follow,
 * and a math node it is wired into, which names its senders in its expression, names it anew.
 */
export const renameNode = (spec: AutomationSpec, from: string, to: string): AutomationSpec => {
  if (!spec.nodes[from] || from === to || nameProblem(spec, to)) return spec;
  const was = new RegExp(`(?<![A-Za-z0-9_])${nameOfSender(from)}(?![A-Za-z0-9_])`, 'g');
  const receivers = new Set(Object.values(wiresBy(spec.nodes[from])).flat());
  const nodes: Record<string, AutomationNodeSpec> = {};
  for (const [id, node] of Object.entries(spec.nodes)) {
    const wires = wiresBy(node);
    let next = withWires(node, Object.fromEntries(Object.entries(wires).map(([output, ids]) => [output, ids.map((each) => each === from ? to : each)])));
    if (receivers.has(id) && next.type === 'math' && typeof next.expression === 'string') {
      next = { ...next, expression: next.expression.replace(was, nameOfSender(to)) };
    }
    nodes[id === from ? to : id] = next;
  }
  return { ...spec, nodes };
};

/** The graph without a node, nor the wires into it. */
export const removeNode = (spec: AutomationSpec, id: string): AutomationSpec => {
  const nodes: Record<string, AutomationNodeSpec> = {};
  for (const [other, node] of Object.entries(spec.nodes)) {
    if (other === id) continue;
    const wires = wiresBy(node);
    nodes[other] = withWires(node, Object.fromEntries(Object.entries(wires).map(([output, ids]) => [output, ids.filter((to) => to !== id)])));
  }
  return { ...spec, nodes };
};

export const moveNode = (spec: AutomationSpec, id: string, pos: Pos): AutomationSpec =>
  spec.nodes[id] ? withNode(spec, id, { ...spec.nodes[id], pos: [Math.round(pos[0]), Math.round(pos[1])] }) : spec;

/**
 * A node's settings changed: a value of `undefined` or `''` takes the setting out. A switch whose
 * cases changed keeps the wires of the cases it still has.
 */
export const setSettings = (spec: AutomationSpec, id: string, changes: Record<string, unknown>): AutomationSpec => {
  const node = spec.nodes[id];
  if (!node) return spec;
  const next: AutomationNodeSpec = { ...node };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined || value === '') delete next[key];
    else next[key] = value;
  }
  const outputs = outputsOf(next);
  const wires = wiresBy(next);
  return withNode(spec, id, withWires(next, Object.fromEntries(Object.entries(wires).filter(([output]) => outputs.includes(output)))));
};
