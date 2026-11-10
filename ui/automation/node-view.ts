/**
 * How a node is drawn on the canvas: its size, where its ports are, and the line that says what
 * it does (`below 30`, `5m`, `on → hall-lamp/switch-0`). Pure, so the canvas and its wires agree.
 */

import type { AutomationNodeSpec, AutomationNodeStatus } from '../../lib/api.ts';
import { outputsOf } from './graph-edit.ts';

export const NODE_WIDTH = 200;
/** The band with the title (`CARD_BAND`), then room for what it does and what it last sent, and a margin. */
const NODE_MIN_HEIGHT = 88;
const PORT_GAP = 20;
/** Room round the nodes on the canvas, so the outermost can be dragged further out. */
export const CANVAS_PAD = 240;

export const nodeHeight = (node: AutomationNodeSpec): number => Math.max(NODE_MIN_HEIGHT, 24 + outputsOf(node).length * PORT_GAP);

/** An output port's place below the node's top. */
export const outputY = (node: AutomationNodeSpec, output: string): number => {
  const outputs = outputsOf(node);
  const top = (nodeHeight(node) - (outputs.length - 1) * PORT_GAP) / 2;
  return top + Math.max(0, outputs.indexOf(output)) * PORT_GAP;
};

export const inputY = (node: AutomationNodeSpec): number => nodeHeight(node) / 2;

/** The middle of `wirePath`'s curve: where a wire's label stands. */
export const wireMiddle = (x1: number, y1: number, x2: number, y2: number): { x: number; y: number } => {
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  // A cubic Bézier at t = ½: (P0 + 3·P1 + 3·P2 + P3) / 8.
  return { x: (x1 + 3 * (x1 + dx) + 3 * (x2 - dx) + x2) / 8, y: (y1 + 3 * y1 + 3 * y2 + y2) / 8 };
};

/** How long a wire's label stays lit after a message went along it. */
export const FRESH_MS = 3000;

/** A message's value on a wire's label: text quoted and cut short, true, false and numbers as they are. */
export const wireValue = (value: unknown): string => {
  const text = typeof value === 'string' ? JSON.stringify(value) : value === null ? 'nothing' : String(value);
  return text.length > 24 ? `${text.slice(0, 23)}…` : text;
};

/** A wire from one port to another, leaving and arriving level. */
export const wirePath = (x1: number, y1: number, x2: number, y2: number): string => {
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
};

const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';

const days = (value: unknown): string => Array.isArray(value) ? value.join(' ') : text(value);

/** What a node does, in a few words. */
export const summaryOf = (node: AutomationNodeSpec): string => {
  const has = (key: string) => node[key] !== undefined && node[key] !== '';
  switch (node.type) {
    case 'device':
      return `${text(node.endpoint)}${has('is') ? ` = ${text(node.is)}` : ''}`;
    case 'online':
      return text(node.device);
    case 'clock':
      return has('every') ? `every ${text(node.every)}` : `${text(node.at)}${has('days') ? ` ${days(node.days)}` : ''}`;
    case 'between':
      return `${text(node.from)}–${text(node.until)}${has('days') ? ` ${days(node.days)}` : ''}`;
    case 'button':
      return has('value') ? `sends ${text(node.value)}` : 'press to send';
    case 'link-in':
    case 'link-out':
      return text(node.name);
    case 'compare':
      return ['is', 'not', 'above', 'below'].filter(has).map((key) => `${key === 'not' ? 'is not' : key} ${text(node[key])}`).join(', ');
    case 'switch':
      return node.cases && typeof node.cases === 'object' ? Object.keys(node.cases).join(', ') : '';
    case 'math':
      return text(node.expression);
    case 'aggregate':
      return text(node.fn);
    case 'set':
      return text(node.value);
    case 'delay':
    case 'held':
    case 'debounce':
    case 'throttle':
      return text(node.for);
    case 'timer':
      return `off after ${text(node['off-after'])}`;
    case 'control':
      return `${has('value') ? text(node.value) : 'the value'} → ${text(node.endpoint)}`;
    case 'shell':
      return text(node.run);
    default:
      return '';
  }
};

const ago = (iso: string, now: number): string => {
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  return seconds < 60 ? `${Math.max(0, seconds)} s ago` : seconds < 3600 ? `${Math.round(seconds / 60)} min ago` : `${Math.round(seconds / 3600)} h ago`;
};

const until = (iso: string, now: number): string => {
  const seconds = Math.max(0, Math.round((Date.parse(iso) - now) / 1000));
  return seconds < 120 ? `in ${seconds} s` : `in ${Math.round(seconds / 60)} min`;
};

/** What a running node waits for, in a few words, as of `now`: what it sent is on its wires. */
export const statusText = (status: AutomationNodeStatus | undefined, now = Date.now()): string => {
  if (!status?.due) return '';
  return `next ${until(status.due, now)}`;
};

/** How long ago `at` was, as of `now`: a wire's label. */
export const agoText = (at: string, now = Date.now()): string => ago(at, now);
