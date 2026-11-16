/**
 * Places the nodes of an automation that have no place yet, left to right as messages flow: each in
 * the column after the furthest node wired into it, and in its column near the nodes that send to
 * it. Nodes that have a place keep it; the placed ones go below them.
 *
 * Import-free, so the editor places a node as `automation-show` does.
 */

/** The width of a column and the height of a row on the canvas. */
const COLUMN = 240;
const ROW = 110;

type LayoutNode = { id: string; pos?: [number, number]; targets: string[] };

/** A place for each node without one, by id. The wires must not go round in a circle. */
export const placeNodes = (nodes: LayoutNode[]): Map<string, [number, number]> => {
  const placed = new Map<string, [number, number]>();
  const open = nodes.filter((node) => !node.pos);
  if (!open.length) return placed;

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const senders = new Map<string, string[]>();
  for (const node of nodes) {
    for (const target of node.targets) if (byId.has(target)) senders.set(target, [...senders.get(target) ?? [], node.id]);
  }

  const column = new Map<string, number>();
  const columnOf = (id: string, seen: Set<string>): number => {
    const known = column.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const from = senders.get(id) ?? [];
    const value = from.length ? Math.max(...from.map((sender) => columnOf(sender, seen))) + 1 : 0;
    column.set(id, value);
    return value;
  };
  for (const node of nodes) columnOf(node.id, new Set());

  const top = nodes.some((node) => node.pos) ? Math.max(...nodes.flatMap((node) => node.pos ? [node.pos[1]] : [])) + ROW * 1.5 : 0;
  const columns = new Map<number, LayoutNode[]>();
  for (const node of open) columns.set(column.get(node.id)!, [...columns.get(column.get(node.id)!) ?? [], node]);

  const yOf = (id: string): number | undefined => placed.get(id)?.[1] ?? byId.get(id)?.pos?.[1];
  for (const index of [...columns.keys()].sort((a, b) => a - b)) {
    const inColumn = columns.get(index)!;
    const order = inColumn.map((node, at) => {
      const ys = (senders.get(node.id) ?? []).map(yOf).filter((y): y is number => y !== undefined);
      return { node, key: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity, at };
    }).sort((a, b) => a.key - b.key || a.at - b.at);
    order.forEach(({ node }, row) => placed.set(node.id, [index * COLUMN, top + row * ROW]));
  }
  return placed;
};
