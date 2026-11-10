/**
 * One automation running: messages flow from its inputs along its wires, each node doing what its
 * kind says, and its actions are handed to `act` one after another.
 *
 * A message is a value, where it came from (`topic`: an endpoint, a folder, `clock`, `button`, an
 * event's type) and when. Every node has one input; `and`, `or`, `math` and `aggregate` keep the
 * latest value of each node wired into them. A node that says true or false (compare, and, or, not, timer, held, between, online)
 * sends only when that changes, unless its `every` is set.
 *
 * Quiet: what the engine is primed with (each endpoint's latest reading, read when it starts) and a
 * message it is told is stale (a retained reading, one that waited in the queue) set every node's
 * state as if it had come, but run no action. Timers count from when a reading came, not from when
 * the engine heard it, so a light whose motion ended four minutes before a restart still goes off a
 * minute after it; a delay, debounce or throttle due before the engine heard it is dropped.
 *
 * Nothing here knows the VFS, the shell or the clock: the service gives them in `EngineOptions`.
 */

import type { AutomationNodeStatus, AutomationValue as Value } from '../api.ts';
import type { Automation, Node } from './graph.ts';
import { evaluate, type Expression, NoValueYet } from './math.ts';
import { type Aggregate, aggregate, nameMatches, passes, same, type Test, truthy, valueOfText, valueText } from './values.ts';
import { nameOfSender } from './graph.ts';
import { type Location, minuteOf, type TimeOfDay } from './sun.ts';

export type Message = {
  value: Value;
  /** Where it came from: `<device>/<endpoint>`, a file's folder, `clock`, `button`, a link's name, an event's type. */
  topic: string;
  /** When, in ms: a reading's own time, not when it was heard. */
  at: number;
  /** A press, which never goes back to false by itself. */
  event?: boolean;
  /** How many nodes it passed: a guard against links that go round. */
  hops: number;
};

/** What a device said, as the service hands it on. */
export type DeviceEvent = {
  device: string;
  /** Absent when the device came or went. */
  endpoint?: string;
  value?: Value;
  online?: boolean;
  event?: boolean;
  /** Ms. */
  at: number;
};

/** A file in a folder a file node watches: one that came (made there or moved in), was written, or is gone. */
export type FileEvent = {
  /** The folder, as its file nodes name it. */
  folder: string;
  path: string;
  change: 'came' | 'written' | 'gone';
  /** It came with nothing in it yet, and is sent once it is written. */
  empty?: boolean;
  /** Ms. */
  at: number;
};

/** An event of EiN, as the service hands it on: its type, the path of the node it is about, its data. */
export type FactEvent = {
  type: string;
  subject: string;
  data?: Record<string, unknown>;
  /** Ms. */
  at: number;
};

export type Action =
  | { kind: 'control'; endpoint: string; value: string }
  | { kind: 'shell'; line: string; env: Record<string, string>; timeoutMs: number }
  | { kind: 'event'; type: string; subject: string; data: Record<string, string> };

export type LogEntry = {
  node: string;
  kind: 'debug' | 'action' | 'error' | 'clock' | 'late';
  value?: Value;
  topic?: string;
  text?: string;
};

/** A node that sent, on which outputs; or one that held a value back, and why. */
type Trace = { node: string; value: Value; outputs?: string[]; skipped?: string };

/** A pending deadline, kept over a restart: when it is due and what it will send. */
export type Deadline = { node: string; due: number; value?: Value; topic?: string };

export type LocalTime = {
  /** `2026-11-09`. */
  day: string;
  /** Minutes since midnight. */
  minute: number;
  /** Monday 0. */
  weekday: number;
};

type EngineOptions = {
  /** Call `fn` after `ms`, and answer how to call it off. */
  schedule(fn: () => void, ms: number): () => void;
  now(): number;
  localTime(ms: number): LocalTime;
  /** Do an action as the automation's owner; a shell's answer is what it printed. */
  act(node: string, action: Action): Promise<Value | void>;
  /** A link out's message, for every link in of that name of the same owner's. */
  link?(name: string, message: Message): void;
  log?(entry: LogEntry): void;
  /** Each send, and each value held back, while not quiet: for following a run step by step. */
  trace?(trace: Trace): void;
};

/** An action as the run log says it. */
const actionText = (action: Action): string =>
  action.kind === 'control' ? `${action.value} > ${action.endpoint}` : action.kind === 'event' ? `${action.type} about ${action.subject}` : action.line;

/** The most nodes a message passes: past it, a message goes round, through links, and is dropped. */
const MAX_HOPS = 64;
const SHELL_TIMEOUT_MS = 30_000;
/** How long a file must go unwritten before a file node sends it: a file written in pieces is sent once, whole. */
const FILE_SETTLE_MS = 2000;
/** The most files a file node waits on to be written: past it, the longest waiting is forgotten. */
const MAX_WAITING_FILES = 1000;

type Timer = { due: number; cancel: () => void; message?: Message };

type NodeState = {
  value?: Value;
  at?: number;
  messages: number;
  problem?: string;
  /** What a true-or-false node last sent, an aggregate's last result. */
  last?: Value;
  /** The latest value of each node wired in. */
  inputs: Map<string, Value>;
  /** What it last sent on each output, and when. */
  byOutput: Map<string, { value: Value; at: number }>;
  timers: Timer[];
  /** A clock's `every` slot, its `at`'s day. */
  slot?: number;
  day?: string;
  /** A throttle's last send. */
  sent?: number;
};

const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

const inWindow = (local: LocalTime, from: number, to: number, days?: number[]): boolean => {
  if (days && !days.includes(local.weekday)) return false;
  return from <= to ? local.minute >= from && local.minute < to : local.minute >= from || local.minute < to;
};

/**
 * What an automation reads: the endpoints its device nodes listen to and its controls write, the
 * devices whose coming and going it follows, the folders its file nodes watch, the events it hears
 * (patterns) and those it raises.
 */
type Reads = { endpoints: string[]; controls: string[]; devices: string[]; folders: string[]; events: string[]; raises: string[] };

export const readsOf = (automation: Automation): Reads => {
  const of = (type: string, key: string) => [...new Set([...automation.nodes.values()].filter((node) => node.type === type).map((node) => node.config[key] as string))];
  return {
    endpoints: of('device', 'endpoint'),
    controls: of('control', 'endpoint'),
    devices: of('online', 'device'),
    folders: of('file', 'folder'),
    events: of('event-in', 'event'),
    raises: of('event-out', 'event'),
  };
};

/** Whether an event's type is one `pattern` names: its words, where `*` is any one word and `#` any number of them. */
export const eventMatches = (pattern: string, type: string): boolean => {
  const want = pattern.split('.');
  const have = type.split('.');
  const match = (i: number, j: number): boolean => {
    if (i === want.length) return j === have.length;
    if (want[i] === '#') return match(i + 1, j) || (j < have.length && match(i, j + 1));
    return j < have.length && (want[i] === '*' || want[i] === have[j]) && match(i + 1, j + 1);
  };
  return match(0, 0);
};

/** A value of an event's data as text, as `with` names it. */
const dataText = (value: unknown): string | undefined => value === undefined || value === null ? undefined : typeof value === 'object' ? JSON.stringify(value) : String(value);

/** Text with `${value}` and `${topic}` filled in from a message. */
const filled = (template: string, value: Value, topic: string): string => template.replaceAll('${value}', valueText(value) ?? '').replaceAll('${topic}', topic);

export class AutomationEngine {
  private readonly states = new Map<string, NodeState>();
  /** The latest reading of each endpoint it reads or writes, `<device>/<endpoint>`. */
  private readonly values = new Map<string, { value: Value; at: number }>();
  private quiet = false;
  private stopped = false;
  private actions: Promise<void> = Promise.resolve();
  private lastTick?: number;
  /** The files a file node will send once nothing more is written to them, by `<node>\n<path>`: how to call each off. */
  private readonly settling = new Map<string, () => void>();
  /** The files that came empty, by `<node>\n<path>`, sent once they are written. */
  private readonly waiting = new Set<string>();

  constructor(readonly name: string, readonly automation: Automation, private readonly options: EngineOptions) {
    for (const id of automation.nodes.keys()) this.states.set(id, { messages: 0, inputs: new Map(), byOutput: new Map(), timers: [] });
  }

  /** What it reads and writes. */
  reads(): Reads {
    return readsOf(this.automation);
  }

  /**
   * Start from what was true before: each endpoint's latest reading (a press is no state, and is
   * not given), each device's coming or going. Quiet: no action runs.
   */
  prime(seeds: { values?: Map<string, { value: Value; at: number }>; online?: Map<string, boolean> }): void {
    this.inQuiet(() => {
      for (const [key, seed] of seeds.values ?? []) {
        const [device, endpoint] = key.split('/');
        this.handleNow({ device, endpoint, value: seed.value, at: seed.at });
      }
      for (const [device, online] of seeds.online ?? []) this.handleNow({ device, online, at: this.options.now() });
      this.tickBetween(this.options.localTime(this.options.now()));
    });
  }

  /** A device's reading, press, or coming and going. */
  handle(event: DeviceEvent, options: { quiet?: boolean } = {}): void {
    if (this.stopped) return;
    if (options.quiet) this.inQuiet(() => this.handleNow(event));
    else this.handleNow(event);
  }

  /**
   * An event of EiN, to each event in whose pattern names its type, about a node under its folder,
   * with the data it asks for. Whether the owner may read the node is the service's to judge first.
   */
  handleEvent(event: FactEvent, options: { quiet?: boolean } = {}): void {
    if (this.stopped) return;
    const handle = () => {
      for (const node of this.automation.nodes.values()) {
        if (node.type !== 'event-in' || !eventMatches(node.config.event as string, event.type)) continue;
        const under = node.config.under as string | undefined;
        if (under && under !== '/' && event.subject !== under && !event.subject.startsWith(`${under}/`)) continue;
        const wanted = Object.entries((node.config.with as Record<string, string> | undefined) ?? {});
        const missing = wanted.find(([key, text]) => dataText(event.data?.[key]) !== text);
        if (missing) {
          if (!this.quiet) this.options.trace?.({ node: node.id, value: event.subject, skipped: `its ${missing[0]} is not ${missing[1]}` });
          continue;
        }
        this.send(node, { value: event.subject, topic: event.type, at: event.at, event: true, hops: 0 }, event.subject);
      }
    };
    if (options.quiet) this.inQuiet(handle);
    else handle();
  }

  /** What the clock says at `now`: called every few seconds. */
  tick(now: number): void {
    if (this.stopped) return;
    const before = this.lastTick;
    this.lastTick = now;
    const local = this.options.localTime(now);
    const earlier = before === undefined ? undefined : this.options.localTime(before);
    for (const node of this.automation.nodes.values()) {
      if (node.type !== 'clock') continue;
      const state = this.state(node.id);
      const every = node.config.every as number | undefined;
      if (every !== undefined) {
        const slot = Math.floor(now / every);
        const was = state.slot;
        state.slot = slot;
        if (was === undefined || slot === was) continue;
      } else {
        const { minute: at, comes } = this.timeToday(node, 'at', now, local);
        const days = node.config.days as number[] | undefined;
        if (!comes || !earlier || state.day === local.day || local.minute < at) continue;
        // Passed since the last tick: earlier today before it, or yesterday.
        if (earlier.day === local.day && earlier.minute >= at) continue;
        state.day = local.day;
        if (days && !days.includes(local.weekday)) continue;
      }
      this.options.log?.({ node: node.id, kind: 'clock', value: hhmm(local.minute) });
      this.send(node, { value: hhmm(local.minute), topic: 'clock', at: now, hops: 0 }, hhmm(local.minute));
    }
    this.tickBetween(local);
  }

  /**
   * A file in a folder: each file node watching it sends its path once nothing more has been
   * written to it for `FILE_SETTLE_MS`. A file that came empty waits until it is written; one that
   * is gone before then is not sent.
   */
  file(event: FileEvent): void {
    if (this.stopped) return;
    const name = event.path.slice(event.path.lastIndexOf('/') + 1);
    for (const node of this.automation.nodes.values()) {
      if (node.type !== 'file' || node.config.folder !== event.folder) continue;
      const key = `${node.id}\n${event.path}`;
      const known = this.settling.has(key) || this.waiting.has(key);
      this.settling.get(key)?.();
      this.settling.delete(key);
      this.waiting.delete(key);
      if (event.change === 'gone') continue;
      const match = node.config.match as string | undefined;
      if (match !== undefined && !nameMatches(match, name)) {
        this.options.trace?.({ node: node.id, value: event.path, skipped: `only names that match ${match} are passed on` });
        continue;
      }
      if (event.change === 'written' && !known && !node.config.changes) continue;
      if (event.change === 'came' && event.empty) {
        this.waiting.add(key);
        if (this.waiting.size > MAX_WAITING_FILES) this.waiting.delete(this.waiting.values().next().value!);
        continue;
      }
      this.settling.set(
        key,
        this.options.schedule(() => {
          this.settling.delete(key);
          if (!this.stopped) this.send(node, { value: event.path, topic: event.folder, at: this.options.now(), event: true, hops: 0 }, event.path);
        }, FILE_SETTLE_MS),
      );
    }
  }

  /** A button node pressed. */
  press(id: string): void {
    const node = this.automation.nodes.get(id);
    if (!node || node.type !== 'button') throw new Error(`${this.name} has no button ${id}`);
    const value = (node.config.value as Value | undefined) ?? true;
    this.send(node, { value, topic: 'button', at: this.options.now(), event: true, hops: 0 }, value);
  }

  /** A link out's message, sent from one of the same owner's automations. */
  link(name: string, message: Message): void {
    if (this.stopped || message.hops > MAX_HOPS) return;
    for (const node of this.automation.nodes.values()) {
      if (node.type === 'link-in' && node.config.name === name) this.send(node, message, message.value);
    }
  }

  /** What each node last did. */
  status(): Record<string, AutomationNodeStatus> {
    const iso = (ms?: number) => ms === undefined ? undefined : new Date(ms).toISOString();
    return Object.fromEntries([...this.states].map(([id, state]) => {
      const due = state.timers.length ? Math.min(...state.timers.map((timer) => timer.due)) : undefined;
      return [id, {
        ...(state.value !== undefined ? { value: state.value } : {}),
        ...(state.at !== undefined ? { at: iso(state.at) } : {}),
        ...(state.byOutput.size ? { outputs: Object.fromEntries([...state.byOutput].map(([output, sent]) => [output, { value: sent.value, at: iso(sent.at)! }])) } : {}),
        ...(due !== undefined ? { due: iso(due) } : {}),
        ...(state.problem ? { problem: state.problem } : {}),
        messages: state.messages,
      }];
    }));
  }

  /** Once the actions begun so far are done, and what they set going has been sent on. */
  settled(): Promise<void> {
    return this.actions;
  }

  /** The deadlines it waits for, to be kept over a restart. */
  pending(): Deadline[] {
    return [...this.states].flatMap(([node, state]) =>
      state.timers.map((timer) => ({
        node,
        due: timer.due,
        ...(timer.message ? { value: timer.message.value, topic: timer.message.topic } : {}),
      }))
    );
  }

  /**
   * Take up the deadlines a run before a restart waited for. A timer or held node that priming set
   * going already keeps its own; one due by now is done at once, logged as late, unless it is later
   * than `maxLateMs`: after a long stop the automation starts afresh from its readings.
   */
  restore(deadlines: Deadline[], maxLateMs = Infinity): void {
    for (const deadline of deadlines) {
      const node = this.automation.nodes.get(deadline.node);
      if (!node || this.options.now() - deadline.due > maxLateMs) continue;
      const state = this.state(node.id);
      const message: Message = { value: deadline.value ?? null, topic: deadline.topic ?? node.id, at: deadline.due, hops: 0 };
      const late = deadline.due < this.options.now();
      if (late) this.options.log?.({ node: node.id, kind: 'late', text: `due ${new Date(deadline.due).toISOString()}` });
      switch (node.type) {
        case 'delay':
        case 'debounce':
        case 'throttle':
          this.after(node, deadline.due, () => this.send(node, { ...message, at: this.options.now() }, message.value), message);
          break;
        case 'timer':
          if (!state.timers.length && state.last !== false) this.after(node, deadline.due, () => this.sendChange(node, message, false));
          break;
        case 'held':
          if (!state.timers.length && state.last !== true) this.after(node, deadline.due, () => this.sendChange(node, message, true));
          break;
      }
    }
  }

  /** Stop: no timer fires and no action starts after this. */
  stop(): void {
    this.stopped = true;
    for (const cancel of this.settling.values()) cancel();
    this.settling.clear();
    this.waiting.clear();
    for (const state of this.states.values()) {
      for (const timer of state.timers) timer.cancel();
      state.timers = [];
    }
  }

  /** Settles once the actions begun so far are done. */
  async idle(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = this.actions;
      await seen;
    } while (seen !== this.actions);
  }

  private inQuiet(fn: () => void): void {
    const was = this.quiet;
    this.quiet = true;
    try {
      fn();
    } finally {
      this.quiet = was;
    }
  }

  private state(id: string): NodeState {
    return this.states.get(id)!;
  }

  private handleNow(event: DeviceEvent): void {
    if (event.endpoint === undefined) {
      if (typeof event.online !== 'boolean') return;
      for (const node of this.automation.nodes.values()) {
        if (node.type === 'online' && node.config.device === event.device) {
          this.sendChange(node, { value: event.online, topic: event.device, at: event.at, hops: 0 }, event.online);
        }
      }
      return;
    }
    if (event.value === undefined) return;
    const key = `${event.device}/${event.endpoint}`;
    if (!event.event) this.values.set(key, { value: event.value, at: event.at });
    for (const node of this.automation.nodes.values()) {
      if (node.type !== 'device' || node.config.endpoint !== key) continue;
      const only = node.config.is as Value | undefined;
      if (only !== undefined && !same(event.value, only)) {
        if (!this.quiet) this.options.trace?.({ node: node.id, value: event.value, skipped: `only ${JSON.stringify(only)} is passed on` });
        continue;
      }
      this.send(node, { value: event.value, topic: key, at: event.at, ...(event.event ? { event: true } : {}), hops: 0 }, event.value);
    }
  }

  private tickBetween(local: LocalTime): void {
    for (const node of this.automation.nodes.values()) {
      if (node.type !== 'between') continue;
      const now = this.options.now();
      const from = this.timeToday(node, 'from', now, local).minute;
      const until = this.timeToday(node, 'until', now, local).minute;
      const inside = inWindow(local, from, until, node.config.days as number[] | undefined);
      this.sendChange(node, { value: inside, topic: 'clock', at: now, hops: 0 }, inside);
    }
  }

  /** The minute of today a node's time setting falls on, a sun time's at the node's location. */
  private timeToday(node: Node, key: string, now: number, local: LocalTime): { minute: number; comes: boolean } {
    return minuteOf(node.config[key] as TimeOfDay, node.config.location as Location | undefined, now, local, this.options.localTime);
  }

  /** Send `value` on from `node`: on `out`, and on `true` or `false` for a node that says which. */
  private send(node: Node, message: Message, value: Value, output?: string): void {
    const state = this.state(node.id);
    state.value = value;
    state.at = message.at;
    const next: Message = { ...message, value, hops: message.hops + 1 };
    if (next.hops > MAX_HOPS) {
      state.problem = 'a message went round too many nodes and was dropped';
      return;
    }
    const outputs = output !== undefined ? [output] : node.kind.boolean ? ['out', truthy(value) ? 'true' : 'false'] : ['out'];
    if (!this.quiet) this.options.trace?.({ node: node.id, value, outputs });
    for (const each of outputs) {
      state.byOutput.set(each, { value, at: message.at });
      for (const target of node.wires[each] ?? []) this.deliver(target, node.id, next);
    }
  }

  /** Send a true or false only when it changed, unless the node's `every` is set. */
  private sendChange(node: Node, message: Message, value: boolean): void {
    const state = this.state(node.id);
    if (state.last === value && !node.config.every) {
      if (!this.quiet) this.options.trace?.({ node: node.id, value, skipped: 'the same as it last sent' });
      return;
    }
    state.last = value;
    this.send(node, message, value);
  }

  /** Call `fn` at `due`, kept as the node's timer meanwhile; at once, after this turn, when it is due by now. */
  private after(node: Node, due: number, fn: () => void, message?: Message): Timer {
    const state = this.state(node.id);
    const timer: Timer = {
      due,
      message,
      cancel: this.options.schedule(() => {
        state.timers = state.timers.filter((each) => each !== timer);
        if (!this.stopped) fn();
      }, Math.max(0, due - this.options.now())),
    };
    state.timers.push(timer);
    return timer;
  }

  /**
   * A timer's or held node's change at `due`. Quiet and due by now, it is the state the node was
   * already in, set without an action: priming must not switch off a lamp a person switched on long
   * after the motion ended.
   */
  private when(node: Node, due: number, fn: () => void): void {
    if (this.quiet && due <= this.options.now()) fn();
    else this.after(node, due, fn);
  }

  private cancelTimers(node: Node): void {
    const state = this.state(node.id);
    for (const timer of state.timers) timer.cancel();
    state.timers = [];
  }

  /** A delay, debounce or throttle that a quiet message would set due by now drops it: it is stale. */
  private stale(due: number): boolean {
    return this.quiet && due <= this.options.now();
  }

  private deliver(id: string, from: string, message: Message): void {
    const node = this.automation.nodes.get(id);
    if (!node) return;
    const state = this.state(id);
    state.messages++;
    state.inputs.set(from, message.value);
    try {
      this.receive(node, state, message);
    } catch (error) {
      state.problem = error instanceof Error ? error.message : String(error);
      if (!this.quiet) this.options.log?.({ node: id, kind: 'error', text: state.problem });
    }
  }

  private wiredIn(node: Node, state: NodeState): Value[] {
    return (this.automation.senders.get(node.id) ?? []).filter((id) => state.inputs.has(id)).map((id) => state.inputs.get(id)!);
  }

  private receive(node: Node, state: NodeState, message: Message): void {
    const { config } = node;
    const value = message.value;
    switch (node.type) {
      case 'compare':
        return this.sendChange(node, message, passes(config as Test, value));
      case 'and':
      case 'or': {
        const senders = this.automation.senders.get(node.id) ?? [];
        const values = senders.map((id) => truthy(state.inputs.get(id)));
        return this.sendChange(node, message, node.type === 'and' ? values.every(Boolean) : values.some(Boolean));
      }
      case 'not':
        return this.sendChange(node, message, !truthy(value));
      case 'switch': {
        const cases = config.cases as { name: string; test: Test }[];
        const hit = cases.find((each) => passes(each.test, value));
        return this.send(node, message, value, hit?.name ?? 'else');
      }
      case 'math': {
        const names: Record<string, Value | undefined> = { value, topic: message.topic };
        for (const id of this.automation.senders.get(node.id) ?? []) names[nameOfSender(id)] = state.inputs.get(id);
        try {
          const result = evaluate(config.expression as Expression, names);
          state.problem = undefined;
          return this.send(node, message, result);
        } catch (error) {
          if (error instanceof NoValueYet) {
            state.problem = `waits for ${error.missing}`;
            return;
          }
          throw error;
        }
      }
      case 'aggregate': {
        const result = aggregate(config.fn as Aggregate, this.wiredIn(node, state));
        if (result === undefined || (!config.every && state.last !== undefined && same(result, state.last))) return;
        state.last = result;
        return this.send(node, message, result);
      }
      case 'set': {
        const wanted = config.value as Value;
        const result = typeof wanted === 'string' && wanted.includes('${') ? filled(wanted, value, message.topic) : wanted;
        return this.send(node, message, result);
      }
      case 'delay': {
        const due = message.at + (config.for as number);
        if (this.stale(due)) return;
        this.after(node, due, () => this.send(node, { ...message, at: this.options.now() }, value), message);
        return;
      }
      case 'debounce': {
        const due = message.at + (config.for as number);
        this.cancelTimers(node);
        if (this.stale(due)) return;
        this.after(node, due, () => this.send(node, { ...message, at: this.options.now() }, value), message);
        return;
      }
      case 'throttle': {
        const now = this.options.now();
        const every = config.for as number;
        if (state.sent === undefined || now - state.sent >= every) {
          if (this.stale(message.at + every)) return;
          state.sent = now;
          return this.send(node, message, value);
        }
        this.cancelTimers(node);
        this.after(node, state.sent + every, () => {
          state.sent = this.options.now();
          this.send(node, { ...message, at: state.sent }, value);
        }, message);
        return;
      }
      case 'timer': {
        const offAfter = config['off-after'] as number;
        this.cancelTimers(node);
        if (truthy(value)) this.sendChange(node, message, true);
        if (!truthy(value) || message.event) {
          this.when(node, message.at + offAfter, () => this.sendChange(node, { ...message, at: this.options.now() }, false));
        }
        return;
      }
      case 'held': {
        if (!truthy(value)) {
          this.cancelTimers(node);
          return this.sendChange(node, message, false);
        }
        if (state.timers.length || state.last === true) return;
        this.when(node, message.at + (config.for as number), () => this.sendChange(node, { ...message, at: this.options.now() }, true));
        return;
      }
      case 'control':
        return this.control(node, state, message);
      case 'shell': {
        if (this.quiet) return;
        const env = { VALUE: valueText(value) ?? '', TOPIC: message.topic };
        const timeoutMs = (config.timeout as number | undefined) ?? SHELL_TIMEOUT_MS;
        this.enqueue(node, { kind: 'shell', line: config.run as string, env, timeoutMs }, (result) => {
          this.send(node, { ...message, at: this.options.now() }, typeof result === 'string' ? valueOfText(result) : result ?? null);
        });
        return;
      }
      case 'event-out': {
        if (this.quiet) return;
        const about = config.subject === undefined ? value : typeof config.subject === 'string' ? filled(config.subject, value, message.topic) : config.subject as Value;
        const subject = valueText(about);
        if (!subject?.startsWith('/')) throw new Error(`it would be about ${JSON.stringify(about)}, which is no path: an event is about a node, such as /home/anna/Photos`);
        const data = { value: valueText(value) ?? '', topic: message.topic, automation: this.name };
        this.enqueue(node, { kind: 'event', type: config.event as string, subject, data }, () => this.send(node, { ...message, at: this.options.now() }, subject));
        return;
      }
      case 'link-out':
        if (!this.quiet) this.options.link?.(config.name as string, message);
        return;
      case 'debug':
        if (!this.quiet) this.options.log?.({ node: node.id, kind: 'debug', value, topic: message.topic });
        state.value = value;
        state.at = message.at;
        return;
    }
  }

  /**
   * Write a control: the node's value, else the one that came. A value the control already has is
   * not written again (a toggle always is); the message goes on either way.
   */
  private control(node: Node, state: NodeState, message: Message): void {
    const endpoint = node.config.endpoint as string;
    const wanted = (node.config.value as Value | undefined) ?? message.value;
    const text = valueText(wanted);
    if (text === undefined) return;
    const current = this.values.get(endpoint);
    if (text !== 'toggle' && current && same(current.value, text)) {
      state.problem = undefined;
      return this.send(node, message, wanted);
    }
    if (this.quiet) return;
    this.enqueue(node, { kind: 'control', endpoint, value: text }, () => this.send(node, { ...message, at: this.options.now() }, wanted));
  }

  /** Run an action after those begun before it, and go on with what it answered. */
  private enqueue(node: Node, action: Action, then: (result: Value | void) => void): void {
    const state = this.state(node.id);
    this.actions = this.actions.then(async () => {
      if (this.stopped) return;
      try {
        const result = await this.options.act(node.id, action);
        state.problem = undefined;
        this.options.log?.({ node: node.id, kind: 'action', text: actionText(action) });
        if (!this.stopped) then(result);
      } catch (error) {
        state.problem = error instanceof Error ? error.message : String(error);
        this.options.log?.({ node: node.id, kind: 'error', text: state.problem });
      }
    });
  }
}
