/**
 * Rules without a broker or a shell: what a rule file says, when a trigger fires and a condition
 * holds, and when the engine runs a rule.
 */

import { assertEquals, assertThrows } from '@std/assert';
import { parse } from '@std/yaml';
import { type Firing, RuleEngine } from '../lib/engine.ts';
import { fires, meets, type Rule, ruleFrom } from '../lib/rules.ts';

const rule = (yaml: string, name = 'test'): Rule => ruleFrom(name, parse(yaml));

Deno.test('rule files: what is read, and what is refused with a reason', () => {
  const read = rule(`
description: The hall lamp follows the porch button
when:
  event: porch-button/input-0
  is: single
if:
  - state: hall-sensor/illuminance
    below: 30
  - online: hall-plug
then: echo toggle > /dev/hall-plug/switch-0
cooldown: 5s
`);
  assertEquals(read.when, [{ kind: 'event', device: 'porch-button', endpoint: 'input-0', is: 'single' }]);
  assertEquals(read.if.length, 2);
  assertEquals([read.then, read.cooldownMs], [['echo toggle > /dev/hall-plug/switch-0'], 5000]);
  assertEquals(rule(`when: [{at: "07:30"}, {every: 15m}]\nthen: [a, b]`).when, [{ kind: 'at', minute: 450 }, { kind: 'every', ms: 900_000 }]);

  for (
    const [yaml, problem] of [
      ['then: x', 'needs when'],
      ['when: {event: porch-button}\nthen: x', '<device>/<endpoint>'],
      ['when: {state: a/b, above: warm}\nthen: x', 'takes a number'],
      ['when: {at: "25:00"}\nthen: x', 'time of day'],
      ['when: {every: 10s}\nthen: x', 'a minute or more'],
      ['when: {state: a/b, for: soon}\nthen: x', 'a duration'],
      ['when: {state: a/b, over: 3}\nthen: x', 'over, which a rule does not read'],
      ['when: {sunrise: true}\nthen: x', 'state, event, online, at or every'],
      ['when: {event: a/b}', 'command lines'],
    ] as const
  ) {
    assertThrows(() => rule(yaml), Error, problem);
  }
});

Deno.test('triggers: a state fires when its value comes, not while it stays', () => {
  const above = rule('when: {state: hall/temperature, above: 25}\nthen: x').when[0];
  const state = (value: number) => ({ kind: 'state' as const, device: 'hall', endpoint: 'temperature', value });
  assertEquals(fires(above, state(26), 24), true);
  assertEquals(fires(above, state(27), 26), false);
  assertEquals(fires(above, state(26), undefined), true);
  assertEquals(fires(above, state(24), 26), false);

  const to = rule('when: {state: hall/door, to: on}\nthen: x').when[0];
  const door = (value: boolean) => ({ kind: 'state' as const, device: 'hall', endpoint: 'door', value });
  assertEquals(fires(to, door(true), false), true);
  assertEquals(fires(to, door(true), true), false);
  const from = rule('when: {state: hall/door, from: on}\nthen: x').when[0];
  assertEquals(fires(from, door(false), true), true);
  assertEquals(fires(from, door(false), false), false);

  const any = rule('when: {state: hall/door}\nthen: x').when[0];
  assertEquals([fires(any, door(true), false), fires(any, door(true), true)], [true, false]);
});

Deno.test('triggers: a press of its kind, a device coming or going', () => {
  const press = rule('when: {event: porch/input-0, is: single}\nthen: x').when[0];
  assertEquals(fires(press, { kind: 'event', device: 'porch', endpoint: 'input-0', value: 'single' }, undefined), true);
  assertEquals(fires(press, { kind: 'event', device: 'porch', endpoint: 'input-0', value: 'long' }, undefined), false);
  const offline = rule('when: {online: plug, is: false}\nthen: x').when[0];
  assertEquals(fires(offline, { kind: 'online', device: 'plug', online: false }, undefined), true);
  assertEquals(fires(offline, { kind: 'online', device: 'plug', online: true }, undefined), false);
});

Deno.test('conditions: on the latest values, on and off as true and false', () => {
  const values = new Map<string, number | boolean>([['hall/lux', 12], ['hall/door', true]]);
  const online = new Map([['plug', true]]);
  const [dark, open, plugOn, missing] = rule(`
when: {event: a/b}
if:
  - {state: hall/lux, below: 30}
  - {state: hall/door, is: "on"}
  - {online: plug}
  - {state: hall/other, is: 1}
then: x
`).if;
  assertEquals([dark, open, plugOn, missing].map((condition) => meets(condition, values, online)), [true, true, true, false]);
});

/** An engine with a clock and timers the test moves. */
const engineFor = (rules: Rule[]) => {
  let now = Date.UTC(2026, 0, 5, 6, 0);
  const timers: { at: number; fn: () => void; off: boolean }[] = [];
  const ran: string[] = [];
  const engine = new RuleEngine({
    run: ({ rule, why }: Firing) => ran.push(`${rule.name}: ${why}`),
    schedule: (fn, ms) => {
      const timer = { at: now + ms, fn, off: false };
      timers.push(timer);
      return () => timer.off = true;
    },
    now: () => now,
    localTime: (ms) => ({ day: new Date(ms).toISOString().slice(0, 10), minute: new Date(ms).getUTCHours() * 60 + new Date(ms).getUTCMinutes() }),
  });
  engine.load(rules);
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers.filter((each) => !each.off && each.at <= now)) {
      timer.off = true;
      timer.fn();
    }
  };
  return { engine, ran, advance, tick: () => engine.tick(now) };
};

Deno.test('the engine: conditions, cooldown, and a state held for a while', () => {
  const lamp = rule('when: {event: porch/input-0}\nif: {state: hall/lux, below: 30}\nthen: x\ncooldown: 5s', 'lamp');
  const fan = rule('when: {state: hall/temperature, above: 25, for: 10m}\nthen: x', 'fan');
  const { engine, ran, advance } = engineFor([lamp, fan]);
  const press = { kind: 'event' as const, device: 'porch', endpoint: 'input-0', value: 'single' };

  engine.handle(press);
  assertEquals(ran, [], 'the lux is not known yet');
  engine.seed('hall/lux', 12);
  engine.handle(press);
  engine.handle(press);
  assertEquals(ran, ['lamp: porch/input-0 "single"'], 'the second press is within the cooldown');
  advance(6000);
  engine.handle(press);
  assertEquals(ran.length, 2);

  const temperature = (value: number) => engine.handle({ kind: 'state', device: 'hall', endpoint: 'temperature', value });
  temperature(26);
  advance(5 * 60_000);
  temperature(24);
  advance(10 * 60_000);
  assertEquals(ran.length, 2, 'it went back below before ten minutes');
  temperature(26);
  advance(10 * 60_000);
  assertEquals(ran.at(-1), 'fan: hall/temperature 26 for 600 s');
});

Deno.test('the engine: at fires once a day when the clock passes it; every at each interval', () => {
  const morning = rule('when: {at: "06:30"}\nthen: x', 'morning');
  const often = rule('when: {every: 15m}\nthen: x', 'often');
  const { ran, advance, tick } = engineFor([morning, often]);
  tick();
  assertEquals(ran, [], 'nothing for a time before the first tick');
  for (let i = 0; i < 6; i++) {
    advance(10 * 60_000);
    tick();
  }
  assertEquals(ran.filter((line) => line.startsWith('morning')), ['morning: at 06:30']);
  assertEquals(ran.filter((line) => line.startsWith('often')).length, 4);
});
