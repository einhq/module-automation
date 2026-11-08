/**
 * The rule engine: the latest value of every entity a rule reads and who is online, and which rules
 * a message or the clock makes run. A run is handed to `run` and not awaited; the engine only says
 * when.
 *
 * A trigger with `for` waits that long after its value came, and is let go if the value leaves
 * before. `at` fires once a day when the clock passes it, `every` at each whole interval; neither
 * fires for a time passed before the engine's first tick. A rule runs only when all its conditions
 * hold, then not again within its cooldown.
 */

import type { Value } from './api.ts';
import { fires, holds, meets, type Message, type Rule, type Trigger } from './rules.ts';

export type Firing = { rule: Rule; why: string };

type EngineOptions = {
  run(firing: Firing): void;
  /** Call `fn` after `ms`, and answer how to call it off. */
  schedule(fn: () => void, ms: number): () => void;
  now(): number;
  /** The minute of the day and the day itself, in the system's time zone. */
  localTime(ms: number): { day: string; minute: number };
};

const describe = (trigger: Trigger, message?: Message): string => {
  switch (trigger.kind) {
    case 'state':
    case 'event':
      return `${trigger.device}/${trigger.entity} ${message && 'value' in message ? JSON.stringify(message.value) : ''}`.trim();
    case 'online':
      return `${trigger.device} ${message?.kind === 'online' && !message.online ? 'offline' : 'online'}`;
    case 'at':
      return `at ${String(Math.floor(trigger.minute / 60)).padStart(2, '0')}:${String(trigger.minute % 60).padStart(2, '0')}`;
    case 'every':
      return `every ${trigger.ms / 60_000} min`;
  }
};

export class RuleEngine {
  private rules: Rule[] = [];
  private readonly values = new Map<string, Value>();
  private readonly online = new Map<string, boolean>();
  private readonly lastRun = new Map<string, number>();
  private readonly waiting = new Map<string, () => void>();
  private readonly slots = new Map<string, number>();
  private readonly days = new Map<string, string>();
  private lastTick?: number;

  constructor(private readonly options: EngineOptions) {}

  /** Replace the rules; what waited for the old ones is let go. */
  load(rules: Rule[]): void {
    for (const cancel of this.waiting.values()) cancel();
    this.waiting.clear();
    this.rules = rules;
  }

  ruleCount(): number {
    return this.rules.length;
  }

  /** An entity's value from before the engine started, unless a message already said a newer one. */
  seed(key: string, value: Value): void {
    if (!this.values.has(key)) this.values.set(key, value);
  }

  seedOnline(device: string, online: boolean): void {
    if (!this.online.has(device)) this.online.set(device, online);
  }

  handle(message: Message): void {
    const key = message.kind === 'online' ? undefined : `${message.device}/${message.entity}`;
    const previous = message.kind === 'state' ? this.values.get(key!) : undefined;
    if (message.kind === 'state') this.values.set(key!, message.value);
    if (message.kind === 'online') this.online.set(message.device, message.online);
    for (const rule of this.rules) {
      rule.when.forEach((trigger, index) => {
        if (trigger.kind === 'state' && trigger.forMs && message.kind === 'state' && message.device === trigger.device && message.entity === trigger.entity) {
          const id = `${rule.name}#${index}`;
          if (!holds(trigger, message.value)) {
            this.waiting.get(id)?.();
            this.waiting.delete(id);
          } else if (fires(trigger, message, previous)) {
            this.waiting.get(id)?.();
            const why = `${describe(trigger, message)} for ${trigger.forMs / 1000} s`;
            this.waiting.set(
              id,
              this.options.schedule(() => {
                this.waiting.delete(id);
                this.fire(rule, why);
              }, trigger.forMs),
            );
          }
          return;
        }
        if (fires(trigger, message, previous)) this.fire(rule, describe(trigger, message));
      });
    }
  }

  /** What the clock makes run at `now`; called every few seconds. */
  tick(now: number): void {
    const before = this.lastTick;
    this.lastTick = now;
    const local = this.options.localTime(now);
    const earlier = before === undefined ? undefined : this.options.localTime(before);
    for (const rule of this.rules) {
      rule.when.forEach((trigger, index) => {
        const id = `${rule.name}#${index}`;
        if (trigger.kind === 'every') {
          const slot = Math.floor(now / trigger.ms);
          const was = this.slots.get(id);
          this.slots.set(id, slot);
          if (was !== undefined && slot !== was) this.fire(rule, describe(trigger));
        } else if (trigger.kind === 'at') {
          if (!earlier || this.days.get(id) === local.day || local.minute < trigger.minute) return;
          // Passed since the last tick: earlier today before it, or yesterday.
          if (earlier.day === local.day && earlier.minute >= trigger.minute) return;
          this.days.set(id, local.day);
          this.fire(rule, describe(trigger));
        }
      });
    }
  }

  private fire(rule: Rule, why: string): void {
    const now = this.options.now();
    const last = this.lastRun.get(rule.name);
    if (last !== undefined && now - last < rule.cooldownMs) return;
    if (!rule.if.every((condition) => meets(condition, this.values, this.online))) return;
    this.lastRun.set(rule.name, now);
    this.options.run({ rule, why });
  }
}
