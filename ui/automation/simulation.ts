/**
 * An automation tried out in the editor: its engine, the one the service runs, on a clock of its
 * own, with nothing real behind it. A control it writes is said and the simulated device takes the
 * value, as a real one would report it back; a command line is said, not run, and sends on an empty value;
 * a link out is said, and reaches the automation's own links in. Readings, presses, a device coming
 * or going, a file coming into a folder and a link's message are fed in by hand; the clock runs on from where it is told to,
 * and timers, clocks and between nodes go off as it passes them.
 *
 * Pure but for `Intl`, so the editor runs it in the browser and the tests on Deno.
 */

import type { AutomationNodeStatus, AutomationValue as Value } from '../../lib/api.ts';
import { type Action, AutomationEngine, type LogEntry } from '../../lib/automations/engine.ts';
import type { Automation } from '../../lib/automations/graph.ts';
import { type Location, minuteOf, type TimeOfDay } from '../../lib/automations/sun.ts';
import { truthy, valueOfText } from '../../lib/automations/values.ts';
import { localTimeIn } from '../../lib/time.ts';

const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
/** How many entries the log keeps, newest first. */
const KEEP = 300;
/** How many values the simulated devices may report back in one go: past it, the automation feeds itself. */
const MAX_ECHOES = 50;

export type SimEntry = {
  at: number;
  node: string;
  /**
   * What happened: an input fed in, a node's send or a value it held back, an action it would have
   * taken, what a debug node said, an error, a clock going off.
   */
  kind: 'input' | 'send' | 'skip' | 'control' | 'shell' | 'link' | 'debug' | 'error' | 'clock';
  text: string;
};

/** A value a control is written with, as a device reports it back: on and off as true and false. */
const reported = (text: string): Value => text === 'on' ? true : text === 'off' ? false : valueOfText(text);

const shown = (value: Value | undefined): string => value === undefined ? '–' : value === null ? 'nothing' : typeof value === 'string' ? `"${value}"` : String(value);

export class Simulation {
  /** The simulated time, in ms. */
  now: number;
  /** What each endpoint holds in the simulation: read at the start, fed in, or written by the automation. */
  readonly values = new Map<string, Value>();
  readonly online = new Map<string, boolean>();
  /** What happened, newest first. */
  entries: SimEntry[] = [];
  readonly engine: AutomationEngine;
  /** Told whenever something changed, for the page to draw it again. */
  onChange?: () => void;
  private timers: { at: number; fn: () => void; order: number }[] = [];
  private order = 0;
  private echoes = 0;

  constructor(readonly automation: Automation, readonly timeZone: string, start: number) {
    this.now = start;
    this.engine = new AutomationEngine('simulation', automation, {
      schedule: (fn, ms) => {
        const timer = { at: this.now + ms, fn, order: this.order++ };
        this.timers.push(timer);
        return () => this.timers = this.timers.filter((each) => each !== timer);
      },
      now: () => this.now,
      localTime: (ms) => localTimeIn(ms, timeZone),
      act: (node, action) => Promise.resolve(this.act(node, action)),
      link: (name, message) => {
        this.add(name, 'link', `would send ${shown(message.value)} to the links named ${name}`);
        this.engine.link(name, { ...message, hops: message.hops + 1 });
      },
      log: (entry) => this.logged(entry),
      trace: (trace) => {
        if (trace.skipped) this.add(trace.node, 'skip', `held back ${shown(trace.value)}: ${trace.skipped}`);
        else {
          const outputs = (trace.outputs ?? []).filter((output) => output !== 'out' || trace.outputs?.length === 1);
          this.add(trace.node, 'send', `sent ${shown(trace.value)}${outputs.length && outputs[0] !== 'out' ? ` on ${outputs.join(' and ')}` : ''}`);
        }
      },
    });
  }

  /**
   * Start from what the devices said last: their readings and whether they are there, set as if
   * they had come, with no action run.
   */
  prime(values: Map<string, { value: Value; at: number }>, online: Map<string, boolean>): void {
    for (const [key, seed] of values) this.values.set(key, seed.value);
    for (const [device, there] of online) this.online.set(device, there);
    this.engine.prime({ values, online });
    this.engine.tick(this.now);
    this.changed();
  }

  /** A reading of `endpoint` (`<device>/<endpoint>`), or a press of it, which is no state. */
  feed(endpoint: string, value: Value, press = false): void {
    const [device, name] = endpoint.split('/');
    this.echoes = 0;
    if (!press) this.values.set(endpoint, value);
    this.add(endpoint, 'input', press ? `pressed: ${shown(value)}` : `reads ${shown(value)}`);
    this.engine.handle({ device, endpoint: name, value, event: press || undefined, at: this.now });
    this.changed();
  }

  /** A device coming or going. */
  setOnline(device: string, online: boolean): void {
    this.online.set(device, online);
    this.add(device, 'input', online ? 'came online' : 'went offline');
    this.engine.handle({ device, online, at: this.now });
    this.changed();
  }

  /** A button node pressed. */
  press(node: string): void {
    this.echoes = 0;
    this.add(node, 'input', 'pressed by hand');
    this.engine.press(node);
    this.changed();
  }

  /** A file named `name` come into the folder of file node `id`, written in full: sent once it has been still a moment. */
  addFile(id: string, name: string): void {
    const folder = this.automation.nodes.get(id)?.config.folder as string | undefined;
    if (folder === undefined) return;
    const path = `${folder === '/' ? '' : folder}/${name}`;
    this.echoes = 0;
    this.add(id, 'input', `a file came: ${path}`);
    this.engine.file({ folder, path, change: 'came', at: this.now });
    this.changed();
  }

  /** A message to the links in named `name`, as a link out of another automation sends it. */
  sendLink(name: string, value: Value): void {
    this.echoes = 0;
    this.add(name, 'input', `a link out sent ${shown(value)}`);
    this.engine.link(name, { value, topic: name, at: this.now, hops: 0 });
    this.changed();
  }

  /** The clock moved to `target`: each timer due before it goes off in turn, and each minute ticks. */
  advanceTo(target: number): void {
    let minute = (Math.floor(this.now / MINUTE) + 1) * MINUTE;
    for (;;) {
      const timer = this.timers.filter((each) => each.at <= target).sort((a, b) => a.at - b.at || a.order - b.order)[0];
      if (timer && timer.at <= minute) {
        this.timers = this.timers.filter((each) => each !== timer);
        this.now = Math.max(this.now, timer.at);
        timer.fn();
      } else if (minute <= target) {
        this.now = minute;
        this.engine.tick(minute);
        minute += MINUTE;
      } else break;
    }
    this.now = Math.max(this.now, target);
    this.changed();
  }

  advance(ms: number): void {
    this.advanceTo(this.now + ms);
  }

  /** When the next timer goes off, if one waits. */
  nextTimer(): number | undefined {
    return this.timers.length ? Math.min(...this.timers.map((each) => each.at)) : undefined;
  }

  /** When clock node `id` next goes off, in the simulation's time zone. */
  nextClock(id: string): number | undefined {
    const node = this.automation.nodes.get(id);
    if (!node || node.type !== 'clock') return undefined;
    const every = node.config.every as number | undefined;
    if (every !== undefined) return (Math.floor(this.now / every) + 1) * every;
    const days = node.config.days as number[] | undefined;
    const localTime = (ms: number) => localTimeIn(ms, this.timeZone);
    const start = Math.floor(this.now / MINUTE) * MINUTE;
    // Today's time if it is still to come, else each day's after it: a sun time moves, and on some days does not come.
    for (let shift = 0; shift <= 8; shift++) {
      const probe = start + shift * DAY;
      const local = localTime(probe);
      const { minute, comes } = minuteOf(node.config.at as TimeOfDay, node.config.location as Location | undefined, probe, local, localTime);
      const next = probe + (minute - local.minute) * MINUTE;
      if (comes && next > this.now && (!days || days.includes(local.weekday))) return next;
    }
    return undefined;
  }

  status(): Record<string, AutomationNodeStatus> {
    return this.engine.status();
  }

  /** Once what the automation set going has run its course. */
  settled(): Promise<void> {
    return this.engine.settled();
  }

  stop(): void {
    this.engine.stop();
    this.timers = [];
  }

  /** An action, said and not done; a control's device reports the value back, as a real one would. */
  private act(node: string, action: Action): Value | void {
    if (action.kind === 'shell') {
      this.add(node, 'shell', `would run: ${action.line}${action.env.VALUE ? ` (VALUE=${action.env.VALUE})` : ''}`);
      this.changed();
      return '';
    }
    const was = this.values.get(action.endpoint);
    const value = action.value === 'toggle' ? !truthy(was) : reported(action.value);
    this.add(node, 'control', action.value === 'toggle' ? `would toggle ${action.endpoint}, to ${value ? 'on' : 'off'}` : `would set ${action.endpoint} to ${action.value}`);
    this.values.set(action.endpoint, value);
    if (++this.echoes > MAX_ECHOES) {
      this.add(node, 'error', `stopped: the automation keeps switching ${action.endpoint} because it switched it`);
    } else {
      const [device, endpoint] = action.endpoint.split('/');
      queueMicrotask(() => this.engine.handle({ device, endpoint, value, at: this.now }));
    }
    this.changed();
  }

  private logged(entry: LogEntry): void {
    if (entry.kind === 'debug') this.add(entry.node, 'debug', `${shown(entry.value)}${entry.topic ? ` from ${entry.topic}` : ''}`);
    else if (entry.kind === 'error') this.add(entry.node, 'error', entry.text ?? 'failed');
    else if (entry.kind === 'clock') this.add(entry.node, 'clock', `it is ${shown(entry.value)}`);
  }

  private add(node: string, kind: SimEntry['kind'], text: string): void {
    this.entries = [{ at: this.now, node, kind, text }, ...this.entries].slice(0, KEEP);
  }

  private changed(): void {
    this.onChange?.();
  }
}
