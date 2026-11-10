/**
 * Automations without a broker, a shell or a clock: what a graph says and what is refused with a
 * reason, how values and expressions are read, where unplaced nodes go, and what the engine does
 * with readings, presses and time on a fake clock.
 */

import { assert, assertEquals, assertThrows } from '@std/assert';
import { parse } from '@std/yaml';
import type { AutomationValue as Value } from '../lib/api.ts';
import { type Action, AutomationEngine, type LocalTime, type LogEntry } from '../lib/automations/engine.ts';
import { canonicalSpec, fingerprint, readAutomation } from '../lib/automations/graph.ts';
import { placeNodes } from '../lib/automations/layout.ts';
import { sunEvent } from '../lib/automations/sun.ts';
import { evaluate, NoValueYet, parseExpression } from '../lib/automations/math.ts';
import { aggregate, same, truthy } from '../lib/automations/values.ts';

/** Timers that run when the test moves the clock, in the order they are due. */
class FakeClock {
  now = Date.UTC(2026, 10, 9, 6, 0); // a Monday, 06:00 in UTC, the time zone the tests read in
  private timers: { at: number; fn: () => void; order: number }[] = [];
  private order = 0;

  schedule = (fn: () => void, ms: number): () => void => {
    const timer = { at: this.now + ms, fn, order: this.order++ };
    this.timers.push(timer);
    return () => this.timers = this.timers.filter((each) => each !== timer);
  };

  localTime = (ms: number): LocalTime => {
    const date = new Date(ms);
    return { day: date.toISOString().slice(0, 10), minute: date.getUTCHours() * 60 + date.getUTCMinutes(), weekday: (date.getUTCDay() + 6) % 7 };
  };

  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const next = this.timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at || a.order - b.order)[0];
      if (!next) break;
      this.timers = this.timers.filter((timer) => timer !== next);
      this.now = Math.max(this.now, next.at);
      next.fn();
    }
    this.now = until;
  }
}

const MIN = 60_000;

const automationOf = (yaml: string) => {
  const { automation, problems } = readAutomation(parse(yaml));
  assertEquals(problems, []);
  return automation!;
};

const problemsOf = (yaml: string) => readAutomation(parse(yaml)).problems;

/** An engine on a fake clock, its actions kept as `<value> > <endpoint>` or the shell line. */
const engineOf = (yaml: string, options: { clock?: FakeClock; shell?: (line: string, env: Record<string, string>) => string } = {}) => {
  const clock = options.clock ?? new FakeClock();
  const acts: string[] = [];
  const logs: LogEntry[] = [];
  const links: { name: string; value: Value }[] = [];
  const engine = new AutomationEngine('test', automationOf(yaml), {
    schedule: clock.schedule,
    now: () => clock.now,
    localTime: clock.localTime,
    act: (_node: string, action: Action) => {
      if (action.kind === 'control') {
        acts.push(`${action.value} > ${action.endpoint}`);
        return Promise.resolve();
      }
      acts.push(action.line);
      return Promise.resolve(options.shell?.(action.line, action.env) ?? '');
    },
    link: (name, message) => links.push({ name, value: message.value }),
    log: (entry) => logs.push(entry),
  });
  const reading = (endpoint: string, value: Value, extra: { at?: number; event?: boolean; quiet?: boolean } = {}) => {
    const [device, name] = endpoint.split('/');
    engine.handle({ device, endpoint: name, value, at: extra.at ?? clock.now, ...(extra.event ? { event: true } : {}) }, { quiet: extra.quiet });
  };
  return { engine, clock, acts, logs, links, reading };
};

const MOTION_LIGHT = `
description: Hall light on motion when dark; off 5 min after motion ends
nodes:
  motion: {type: device, endpoint: hall-sensor/motion, to: [linger]}
  linger: {type: timer, off-after: 5m, to: {true: [dark-and-moving], false: [lamp-off]}}
  lux: {type: device, endpoint: hall-sensor/illuminance, to: [dark]}
  dark: {type: compare, below: 30, to: [dark-and-moving]}
  dark-and-moving: {type: and, to: {true: [lamp-on]}}
  lamp-on: {type: control, endpoint: hall-lamp/switch-0, value: on}
  lamp-off: {type: control, endpoint: hall-lamp/switch-0, value: off}
`;

const HEATER = `
description: Keep it between 19 and 21 °C while someone is home
nodes:
  temperature: {type: device, endpoint: indoor/temperature, to: [cold, warm]}
  cold: {type: compare, below: 19, to: [cold-a-while]}
  cold-a-while: {type: held, for: 10m, to: [heat]}
  away: {type: device, endpoint: indoor/away, to: [home]}
  home: {type: not, to: [heat]}
  heat: {type: and, to: {true: [heater-on]}}
  warm: {type: compare, above: 21, to: [warm-a-while]}
  warm-a-while: {type: held, for: 5m, to: {true: [heater-off]}}
  heater-on: {type: control, endpoint: hall-heater/switch-0, value: on}
  heater-off: {type: control, endpoint: hall-heater/switch-0, value: off}
`;

const PORCH = `
description: The porch button toggles the hall lamp and notes each press
nodes:
  press: {type: device, endpoint: porch-button/input-0, is: single, to: [toggle, note]}
  try-it: {type: button, label: Press now, to: [toggle]}
  toggle: {type: control, endpoint: hall-lamp/switch-0, value: toggle}
  note: {type: shell, run: 'echo "porch $VALUE" >> ~/porch.log', to: [show]}
  show: {type: debug}
`;

Deno.test('graphs: the examples are read, with their wires and senders', () => {
  for (const yaml of [MOTION_LIGHT, HEATER, PORCH]) automationOf(yaml);
  const automation = automationOf(MOTION_LIGHT);
  assertEquals(automation.nodes.get('linger')!.wires, { true: ['dark-and-moving'], false: ['lamp-off'] });
  assertEquals(automation.nodes.get('linger')!.config['off-after'], 5 * MIN);
  assertEquals(automation.senders.get('dark-and-moving'), ['linger', 'dark']);
  assertEquals(automation.enabled, true);
  assertEquals(automationOf('enabled: false\nnodes: {}').enabled, false);
  const clock = automationOf('nodes: {wake: {type: clock, at: "6:30", days: weekdays}, sat: {type: clock, at: "08:00", days: [sat, Sunday]}}');
  assertEquals([clock.nodes.get('wake')!.config.at, clock.nodes.get('wake')!.config.days], [390, [0, 1, 2, 3, 4]]);
  assertEquals(clock.nodes.get('sat')!.config.days, [5, 6]);
  const sun = automationOf(`
nodes:
  dusk: {type: clock, at: sunset-30m, location: '59.33, 18.07'}
  dark: {type: between, from: dusk, until: 'Sunrise + 1h', location: [-33.9, 18.4]}`);
  assertEquals([sun.nodes.get('dusk')!.config.at, sun.nodes.get('dusk')!.config.location], [{ sun: 'sunset', offset: -30 * MIN }, [59.33, 18.07]]);
  assertEquals([sun.nodes.get('dark')!.config.from, sun.nodes.get('dark')!.config.until], [{ sun: 'dusk', offset: 0 }, { sun: 'sunrise', offset: 60 * MIN }]);
  assertEquals(sun.nodes.get('dark')!.config.location, [-33.9, 18.4]);
});

Deno.test('graphs: what is wrong is said, with the node it is in', () => {
  const cases: [string, string, string?][] = [
    ['nodes: {a: {type: sensor}}', 'is no kind of node', 'a'],
    ['nodes: {a: {type: device}}', 'endpoint is needed', 'a'],
    ['nodes: {a: {type: device, endpoint: hall}}', '<device>/<endpoint>', 'a'],
    ['nodes: {a: {type: device, endpoint: a/b, above: 3}}', 'above: a device node does not read this', 'a'],
    ['nodes: {a: {type: delay, for: soon}}', 'a duration', 'a'],
    ['nodes: {a: {type: compare}}', 'is, not, above or below', 'a'],
    ['nodes: {a: {type: compare, above: warm}}', 'takes a number', 'a'],
    ['nodes: {a: {type: clock, at: "25:00"}}', 'time of day', 'a'],
    ['nodes: {a: {type: clock, at: "07:00", every: 1h}}', 'at or every, one of them', 'a'],
    ['nodes: {a: {type: clock, every: 10s}}', 'a minute or more', 'a'],
    ['nodes: {a: {type: clock, at: "07:00", days: [someday]}}', 'mon, tue or weekdays', 'a'],
    ['nodes: {a: {type: clock, at: sunset}}', 'at follows the sun, so it needs a location', 'a'],
    ['nodes: {a: {type: between, from: "22:00", until: dawn}}', 'until follows the sun, so it needs a location', 'a'],
    ['nodes: {a: {type: clock, at: sunset-soon, location: "1, 2"}}', 'an offset under a day', 'a'],
    ['nodes: {a: {type: clock, at: noon, location: "1, 2"}}', 'or sunrise, sunset, dawn or dusk', 'a'],
    ['nodes: {a: {type: clock, at: sunset, location: "95, 2"}}', 'a latitude and a longitude', 'a'],
    ['nodes: {a: {type: clock, at: sunset, location: "59.3"}}', 'a latitude and a longitude', 'a'],
    ['nodes: {a: {type: aggregate, fn: median}}', 'one of avg', 'a'],
    ['nodes: {a: {type: device, endpoint: a/b, to: [b]}}', 'names b, which is no node', 'a'],
    ['nodes: {a: {type: not, to: [b]}, b: {type: clock, every: 1h}}', 'nothing is wired into', 'a'],
    ['nodes: {a: {type: device, endpoint: a/b, to: {true: [b]}}, b: {type: debug}}', 'no output true', 'a'],
    ['nodes: {a: {type: not, to: [a]}}', 'wired into itself', 'a'],
    ['nodes: {a: {type: not, to: [b]}, b: {type: not, to: [a]}}', 'round in a circle: a → b → a', 'a'],
    ['nodes: {a: {type: math, expression: "value + other"}}', 'reads other', 'a'],
    ['nodes: {a: {type: math, expression: "value +"}}', 'expected a value', 'a'],
    ['nodes: {a: {type: switch, cases: {else: {is: 1}}}}', 'not else', 'a'],
    ['nodes: {a: {type: link-out, name: x, to: [b]}, b: {type: debug}}', 'sends on nothing', 'a'],
    ['nodes: {"a b": {type: debug}}', 'letters, digits', 'a b'],
    ['nodes: {a: {type: debug, pos: [1]}}', 'pos takes [x, y]', 'a'],
    ['when: {event: a/b}\nnodes: {}', 'when: an automation has description, enabled and nodes'],
    ['description: x', 'nodes takes the nodes by id'],
  ];
  for (const [yaml, message, node] of cases) {
    const problems = problemsOf(yaml);
    assert(problems.some((problem) => problem.message.includes(message) && problem.node === node), `${yaml}: ${JSON.stringify(problems)}`);
  }
  assertEquals(problemsOf('nodes: {a: {type: sensor}, b: {type: delay}}').length, 2);
});

Deno.test('graphs: written back in order, with positions that leave the fingerprint alone', () => {
  const spec = {
    nodes: {
      lamp: { pos: [10.4, 20.6] as [number, number], value: 'on', endpoint: 'hall-lamp/switch-0', type: 'control', label: 'Lamp', to: { out: [] } },
      motion: { to: { out: ['lamp'] }, type: 'device', endpoint: 'hall-sensor/motion' },
      check: { type: 'compare', below: 30, to: { true: ['lamp'], false: [] } },
    },
  };
  const written = canonicalSpec(spec);
  assertEquals(Object.keys(written.nodes.lamp), ['type', 'label', 'endpoint', 'value', 'pos']);
  assertEquals(written.nodes.lamp.pos, [10, 21]);
  assertEquals(written.nodes.motion.to, ['lamp']);
  assertEquals(written.nodes.check.to, { true: ['lamp'] });
  const moved = { nodes: { ...spec.nodes, lamp: { ...spec.nodes.lamp, pos: [300, 300] as [number, number], label: 'The lamp' } } };
  assertEquals(fingerprint(moved), fingerprint(spec));
  const changed = { nodes: { ...spec.nodes, lamp: { ...spec.nodes.lamp, value: 'off' } } };
  assert(fingerprint(changed) !== fingerprint(spec));
});

Deno.test('values: true and false, the same value, aggregates', () => {
  assertEquals([true, 1, 'on', 'ON', 'open', 'single', '2'].map(truthy), [true, true, true, true, true, true, true]);
  assertEquals([false, 0, 'off', 'false', 'closed', '', '0', null].map(truthy), [false, false, false, false, false, false, false, false]);
  assertEquals([same(true, 'on'), same('off', false), same(21, '21'), same('21.0', 21), same('a', 'b'), same(null, null)], [true, true, true, true, false, true]);
  assertEquals(aggregate('avg', [20, '21.5', 'x']), 20.75);
  assertEquals([aggregate('min', [3, 1, 2]), aggregate('max', [3, 1, 2]), aggregate('sum', [0.1, 0.2])], [1, 3, 0.3]);
  assertEquals([aggregate('count', [true, 'off', 'on']), aggregate('any', [false, 'on']), aggregate('all', [true, 'off'])], [2, true, false]);
  assertEquals([aggregate('last', [1, 2]), aggregate('avg', ['x']), aggregate('avg', [])], [2, undefined, undefined]);
});

Deno.test('expressions: arithmetic, comparisons, text, functions, and what is refused', () => {
  const run = (text: string, names: Record<string, Value | undefined> = {}) => evaluate(parseExpression(text), names);
  assertEquals(run('value * 1.8 + 32', { value: 20 }), 68);
  assertEquals(run('round(value, 1)', { value: 21.456 }), 21.5);
  assertEquals(run('2 + 3 * 4 - (1 + 1)'), 12);
  assertEquals(run('outdoor - indoor', { outdoor: 3, indoor: '21.5' }), -18.5);
  assertEquals(run("value > 25 ? 'warm' : 'cool'", { value: 26 }), 'warm');
  assertEquals(run('value == on and not (other != 3)', { value: true, other: 3 }), true);
  assertEquals(run('"temp " + value + " °C"', { value: 21 }), 'temp 21 °C');
  assertEquals(run('clamp(value, 5, 30) + max(1, 2) + min(1, 2) + abs(-1) + floor(1.7) + ceil(1.2)', { value: 40 }), 37);
  assertEquals(run('avg(1, 2, 3) + sum(1, 2) % 2'), 3);
  assertEquals(run('-value', { value: 2 }), -2);
  assertThrows(() => run('other', { value: 1 }), Error, 'not a name');
  assertThrows(() => run('other', { other: undefined }), NoValueYet);
  assertThrows(() => run('1 / 0'), Error, 'division by zero');
  assertThrows(() => run("'a' * 2"), Error, 'takes a number');
  assertThrows(() => parseExpression('median(1)'), Error, 'no function');
  assertThrows(() => parseExpression('round()'), Error, 'takes 1 or more');
  assertThrows(() => parseExpression('1 2'), Error, 'not understood');
  assertThrows(() => parseExpression("'open"), Error, 'not closed');
  assertThrows(() => parseExpression(''), Error, 'empty');
});

Deno.test('layout: columns as messages flow, rows near their senders, placed nodes kept', () => {
  const placed = placeNodes([
    { id: 'motion', targets: ['timer'] },
    { id: 'lux', targets: ['dark'] },
    { id: 'timer', targets: ['both'] },
    { id: 'dark', targets: ['both'] },
    { id: 'both', targets: ['lamp'] },
    { id: 'lamp', targets: [] },
  ]);
  assertEquals(placed.get('motion'), [0, 0]);
  assertEquals(placed.get('lux'), [0, 110]);
  assertEquals(placed.get('timer'), [240, 0]);
  assertEquals(placed.get('dark'), [240, 110]);
  assertEquals(placed.get('both'), [480, 0]);
  assertEquals(placed.get('lamp'), [720, 0]);
  const some = placeNodes([{ id: 'a', pos: [0, 300], targets: ['b'] }, { id: 'b', targets: [] }]);
  assertEquals([some.has('a'), some.get('b')], [false, [240, 465]]);
});

Deno.test('engine: the motion light goes on when dark and off five minutes after the motion', async () => {
  const { engine, clock, acts, reading } = engineOf(MOTION_LIGHT);
  engine.prime({ values: new Map([['hall-sensor/illuminance', { value: 10, at: clock.now }], ['hall-lamp/switch-0', { value: 'off', at: clock.now }]]) });
  reading('hall-sensor/motion', true);
  await engine.idle();
  assertEquals(acts, ['on > hall-lamp/switch-0']);
  reading('hall-lamp/switch-0', 'on');

  reading('hall-sensor/motion', false);
  clock.advance(4 * MIN);
  reading('hall-sensor/motion', true);
  reading('hall-sensor/motion', false);
  clock.advance(4 * MIN);
  await engine.idle();
  assertEquals(acts.length, 1, 'motion again holds the light on');
  assert(engine.status().linger.due);
  clock.advance(MIN);
  await engine.idle();
  assertEquals(acts, ['on > hall-lamp/switch-0', 'off > hall-lamp/switch-0']);

  reading('hall-sensor/illuminance', 200);
  reading('hall-sensor/motion', true);
  await engine.idle();
  assertEquals(acts.length, 2, 'not when it is light');
});

Deno.test('engine: the heater goes on once it has been cold a while, only when someone is home', async () => {
  const { engine, clock, acts, reading } = engineOf(HEATER);
  engine.prime({ values: new Map([['indoor/away', { value: false, at: clock.now }], ['indoor/temperature', { value: 20, at: clock.now }]]) });
  reading('indoor/temperature', 18.5);
  clock.advance(5 * MIN);
  reading('indoor/temperature', 18);
  clock.advance(5 * MIN);
  await engine.idle();
  assertEquals(acts, ['on > hall-heater/switch-0']);

  reading('indoor/temperature', 21.5);
  clock.advance(4 * MIN);
  reading('indoor/temperature', 20.5);
  clock.advance(5 * MIN);
  await engine.idle();
  assertEquals(acts.length, 1, 'warm for four minutes is not five');
  reading('indoor/temperature', 21.5);
  clock.advance(5 * MIN);
  await engine.idle();
  assertEquals(acts, ['on > hall-heater/switch-0', 'off > hall-heater/switch-0']);

  reading('indoor/away', true);
  reading('indoor/temperature', 17);
  clock.advance(20 * MIN);
  await engine.idle();
  assertEquals(acts.length, 2, 'not while away');
});

Deno.test('engine: a press toggles, runs a line with its value, and is written to the log', async () => {
  const { engine, acts, logs, reading } = engineOf(PORCH, { shell: (_line, env) => `noted ${env.VALUE}` });
  reading('porch-button/input-0', 'single', { event: true });
  reading('porch-button/input-0', 'long', { event: true });
  await engine.idle();
  assertEquals(acts, ['toggle > hall-lamp/switch-0', 'echo "porch $VALUE" >> ~/porch.log']);
  assertEquals(logs.filter((log) => log.kind === 'debug').map((log) => log.value), ['noted single']);
  engine.press('try-it');
  engine.press('try-it');
  await engine.idle();
  assertEquals(acts.filter((act) => act.startsWith('toggle')).length, 3, 'a toggle is written every time');
  assertThrows(() => engine.press('toggle'), Error, 'no button toggle');
});

Deno.test('engine: switch, math over senders, aggregate, set', async () => {
  const { engine, logs, reading } = engineOf(`
nodes:
  hall: {type: device, endpoint: hall/temperature, to: [avg, diff]}
  kitchen: {type: device, endpoint: kitchen/temperature, to: [avg, diff]}
  avg: {type: aggregate, fn: avg, to: [band]}
  diff: {type: math, expression: "round(hall - kitchen, 1)", to: [diff-log]}
  diff-log: {type: debug}
  band: {type: switch, cases: {cold: {below: 18}, warm: {above: 23}}, to: {cold: [say-cold], warm: [say-warm], else: [say-ok]}}
  say-cold: {type: set, value: "cold at \${value}", to: [said]}
  say-warm: {type: set, value: warm, to: [said]}
  say-ok: {type: set, value: ok, to: [said]}
  said: {type: debug}
`);
  const said = () => logs.filter((log) => log.node === 'said').map((log) => log.value);
  reading('hall/temperature', 17);
  assertEquals(engine.status().diff.problem, 'waits for kitchen');
  reading('kitchen/temperature', 16);
  reading('kitchen/temperature', 30);
  reading('kitchen/temperature', 30);
  await engine.idle();
  assertEquals(said(), ['cold at 17', 'cold at 16.5', 'warm']);
  assertEquals(logs.filter((log) => log.node === 'diff-log').map((log) => log.value), [1, -13, -13]);
  assertEquals(engine.status().avg.value, 23.5);
});

Deno.test('engine: delay, debounce and throttle', () => {
  const { engine, clock, logs, reading } = engineOf(`
nodes:
  in: {type: device, endpoint: a/b, to: [later, settled, sparse]}
  later: {type: delay, for: 1m, to: [d1]}
  settled: {type: debounce, for: 1m, to: [d2]}
  sparse: {type: throttle, for: 1m, to: [d3]}
  d1: {type: debug}
  d2: {type: debug}
  d3: {type: debug}
`);
  const seen = (node: string) => logs.filter((log) => log.node === node).map((log) => log.value);
  reading('a/b', 1);
  clock.advance(20_000);
  reading('a/b', 2);
  clock.advance(20_000);
  reading('a/b', 3);
  assertEquals([seen('d1'), seen('d2'), seen('d3')], [[], [], [1]]);
  clock.advance(30_000);
  assertEquals(seen('d1'), [1]);
  assertEquals(seen('d3'), [1, 3], 'the newest at the end of the minute');
  clock.advance(60_000);
  assertEquals([seen('d1'), seen('d2')], [[1, 2, 3], [3]]);
  assertEquals(engine.pending(), []);
});

Deno.test('engine: a clock at a time on its days, every so often, and a window', () => {
  const { engine, clock, logs } = engineOf(`
nodes:
  wake: {type: clock, at: "06:30", days: weekdays, to: [w]}
  weekend: {type: clock, at: "06:30", days: weekends, to: [we]}
  often: {type: clock, every: 15m, to: [o]}
  night: {type: between, from: "22:00", until: "06:15", to: [n]}
  w: {type: debug}
  we: {type: debug}
  o: {type: debug}
  n: {type: debug}
`); // a Monday, 06:00
  engine.prime({});
  assertEquals(engine.status().night.value, true);
  const seen = (node: string) => logs.filter((log) => log.node === node).map((log) => log.value);
  for (let i = 0; i < 450; i++) {
    clock.advance(10_000);
    engine.tick(clock.now);
  }
  assertEquals(seen('w'), ['06:30']);
  assertEquals(seen('we'), []);
  assertEquals(seen('o'), ['06:15', '06:30', '06:45', '07:00', '07:15']);
  assertEquals(seen('n'), [false], 'out of the window at 06:15');
});

Deno.test('sun: sunrise, sunset, dawn and dusk where they come, and where the sun stays up or down', () => {
  const minute = (ms: number | string) => typeof ms === 'number' ? new Date(ms).toISOString().slice(11, 16) : ms;
  const noon = Date.UTC(2026, 10, 10, 11);
  // Latitude 59.33° N, 18.07° E on 10 November, in UTC: sunrise 06:30, sunset 14:36, an hour behind the clock there.
  assertEquals((['dawn', 'sunrise', 'sunset', 'dusk'] as const).map((event) => minute(sunEvent(noon, [59.33, 18.07], event))), ['05:43', '06:29', '14:36', '15:22']);
  assertEquals(minute(sunEvent(noon, [40.71, -74], 'sunset')), '21:44');
  assertEquals(sunEvent(Date.UTC(2026, 5, 21, 11), [78.2, 15.6], 'sunset'), 'up');
  assertEquals(sunEvent(noon, [78.2, 15.6], 'sunrise'), 'down');
  assertEquals(sunEvent(Date.UTC(2026, 5, 21, 11), [64, 22], 'dusk'), 'up', 'the sun sets there at midsummer, but not 6° below the horizon');
  assertEquals(typeof sunEvent(Date.UTC(2026, 5, 21, 11), [64, 22], 'sunset'), 'number');
});

Deno.test('engine: a clock at sunset and a window from sunset until sunrise, and where the sun does not set', () => {
  const yaml = (location: string) => `
nodes:
  evening: {type: clock, at: sunset-10m, location: '${location}', to: [e]}
  dark: {type: between, from: sunset, until: sunrise, location: '${location}', to: [d]}
  e: {type: debug}
  d: {type: debug}
`;
  const { engine, clock, logs } = engineOf(yaml('59.33, 18.07')); // a Monday, 06:00 UTC: before sunrise there
  engine.prime({});
  assertEquals(engine.status().dark.value, true);
  const seen = (node: string) => logs.filter((log) => log.node === node).map((log) => log.value);
  const sunset = sunEvent(clock.now + 6 * 60 * MIN, [59.33, 18.07], 'sunset') as number;
  for (let i = 0; i < 24 * 60; i++) {
    clock.advance(MIN);
    engine.tick(clock.now);
  }
  const at = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  assertEquals(seen('e'), [at(sunset - 10 * MIN)]);
  assertEquals(seen('d'), [false, true], 'out of the window at sunrise, in it at sunset');

  const polar = engineOf(yaml('78.2, 15.6')); // November there is polar night: the sun neither rises nor sets
  polar.engine.prime({});
  for (let i = 0; i < 24 * 60; i++) {
    polar.clock.advance(MIN);
    polar.engine.tick(polar.clock.now);
  }
  assertEquals(polar.engine.status().dark.value, true, 'dark all day');
  assertEquals(polar.logs.filter((log) => log.node === 'e'), [], 'no sunset to go off at');
});

Deno.test('engine: priming sets state without acting, and a timer counts from the reading', async () => {
  const restarted = (motionAt: number) => {
    const clock = new FakeClock();
    const run = engineOf(MOTION_LIGHT, { clock });
    run.engine.prime({
      values: new Map([
        ['hall-sensor/motion', { value: false, at: clock.now - motionAt }],
        ['hall-sensor/illuminance', { value: 10, at: clock.now - motionAt }],
        ['hall-lamp/switch-0', { value: 'on', at: clock.now - motionAt }],
      ]),
    });
    return run;
  };
  const recent = restarted(4 * MIN);
  recent.clock.advance(0);
  await recent.engine.idle();
  assertEquals(recent.acts, [], 'not yet');
  recent.clock.advance(MIN);
  await recent.engine.idle();
  assertEquals(recent.acts, ['off > hall-lamp/switch-0'], 'five minutes after the motion, not after the restart');

  const long = restarted(60 * MIN);
  long.clock.advance(10 * MIN);
  await long.engine.idle();
  assertEquals(long.acts, [], 'a lamp switched on long after the motion ended stays on');

  const lit = engineOf(MOTION_LIGHT);
  lit.engine.prime({ values: new Map([['hall-sensor/motion', { value: true, at: lit.clock.now }], ['hall-sensor/illuminance', { value: 10, at: lit.clock.now }]]) });
  await lit.engine.idle();
  assertEquals(lit.acts, [], 'priming runs no action');
  assertEquals(lit.engine.status()['dark-and-moving'].value, true);
});

Deno.test('engine: a quiet message moves state but acts on nothing, and a stale delay is dropped', async () => {
  const { engine, clock, acts, logs, reading } = engineOf(`
nodes:
  press: {type: device, endpoint: porch/input-0, to: [toggle, later]}
  toggle: {type: control, endpoint: hall-lamp/switch-0, value: toggle}
  later: {type: delay, for: 5s, to: [shown]}
  shown: {type: debug}
`);
  reading('porch/input-0', 'single', { event: true, quiet: true, at: clock.now - 2 * MIN });
  clock.advance(MIN);
  await engine.idle();
  assertEquals([acts, logs], [[], []]);
  reading('porch/input-0', 'single', { event: true, quiet: true, at: clock.now - 1000 });
  clock.advance(MIN);
  await engine.idle();
  assertEquals(acts, []);
  assertEquals(logs.map((log) => log.node), ['shown'], 'a delay still due when it is heard goes on');
});

Deno.test('engine: a control is not written to a value it has, and passes the message on', async () => {
  const { engine, acts, logs, reading } = engineOf(`
nodes:
  in: {type: device, endpoint: a/b, to: [follow]}
  follow: {type: control, endpoint: hall-lamp/switch-0, to: [after]}
  after: {type: debug}
`);
  reading('hall-lamp/switch-0', 'on');
  reading('a/b', true);
  reading('a/b', false);
  reading('a/b', null);
  await engine.idle();
  assertEquals(acts, ['off > hall-lamp/switch-0']);
  assertEquals(logs.filter((log) => log.kind === 'debug').map((log) => log.value), [true, false]);
});

Deno.test('engine: deadlines are kept over a restart, and late ones are done at once', () => {
  const yaml = `
nodes:
  in: {type: device, endpoint: a/b, to: [later]}
  later: {type: delay, for: 10m, to: [shown]}
  shown: {type: debug}
`;
  const before = engineOf(yaml);
  before.reading('a/b', 7);
  const pending = before.engine.pending();
  assertEquals(pending.map((each) => [each.node, each.value]), [['later', 7]]);
  before.engine.stop();

  const clock = new FakeClock();
  clock.now = before.clock.now + 15 * MIN;
  const after = engineOf(yaml, { clock });
  after.engine.restore(pending);
  clock.advance(0);
  assertEquals(after.logs.map((log) => [log.kind, log.value ?? null]), [['late', null], ['debug', 7]]);
});

Deno.test('engine: links between automations, online, and errors that are kept on the node', async () => {
  const { engine, acts, links, logs } = engineOf(`
nodes:
  plug: {type: online, device: hall-plug, to: {false: [gone]}}
  gone: {type: link-out, name: plug-gone}
  heard: {type: link-in, name: plug-back, to: [fail]}
  fail: {type: shell, run: exit 1}
`);
  engine.handle({ device: 'hall-plug', online: true, at: 0 });
  engine.handle({ device: 'hall-plug', online: false, at: 0 });
  engine.handle({ device: 'hall-plug', online: false, at: 0 });
  assertEquals(links, [{ name: 'plug-gone', value: false }]);

  const failing = new AutomationEngine('failing', automationOf('nodes: {heard: {type: link-in, name: x, to: [fail]}, fail: {type: shell, run: exit 1}}'), {
    schedule: () => () => {},
    now: () => 0,
    localTime: () => ({ day: '2026-11-09', minute: 0, weekday: 0 }),
    act: () => Promise.reject(new Error('exit 1 failed (1)')),
    log: (entry) => logs.push(entry),
  });
  failing.link('x', { value: 1, topic: 'x', at: 0, hops: 0 });
  await failing.idle();
  assertEquals(failing.status().fail.problem, 'exit 1 failed (1)');
  assertEquals(logs.at(-1)?.kind, 'error');
  assertEquals(acts, []);
  failing.stop();
  failing.link('x', { value: 1, topic: 'x', at: 0, hops: 70 });
});

const INBOX = `
nodes:
  scan: {type: file, folder: /home/anna/inbox/, match: '*.pdf', to: [show]}
  show: {type: debug}
`;

Deno.test('graphs: a file node takes a whole folder path, without a slash at its end', () => {
  assertEquals(automationOf(INBOX).nodes.get('scan')?.config.folder, '/home/anna/inbox');
  for (const folder of ['inbox', '/home/anna/../bo', '/home//anna']) {
    assertEquals(problemsOf(`nodes: {scan: {type: file, folder: '${folder}'}}`)[0].message.startsWith('folder takes a folder'), true, folder);
  }
});

Deno.test('engine: a file is sent once written in full, if its name matches, and not once gone', () => {
  const { engine, clock, logs } = engineOf(INBOX);
  const sent = () => logs.filter((log) => log.kind === 'debug').map((log) => log.value);
  const file = (path: string, change: 'came' | 'written' | 'gone', options: { empty?: boolean; folder?: string } = {}) =>
    engine.file({ folder: options.folder ?? '/home/anna/inbox', path, change, ...(options.empty ? { empty: true } : {}), at: clock.now });

  file('/home/anna/inbox/a.pdf', 'came', { empty: true });
  clock.advance(5000);
  assertEquals(sent(), [], 'not while it is empty');
  file('/home/anna/inbox/a.pdf', 'written');
  clock.advance(1000);
  file('/home/anna/inbox/a.pdf', 'written');
  clock.advance(1999);
  assertEquals(sent(), [], 'not while it is written to');
  clock.advance(1);
  assertEquals(sent(), ['/home/anna/inbox/a.pdf']);
  assertEquals(logs.at(-1)?.topic, '/home/anna/inbox');

  file('/home/anna/inbox/a.pdf', 'written');
  file('/home/anna/inbox/notes.txt', 'came');
  file('/home/anna/inbox/B.PDF', 'came');
  file('/home/anna/other/c.pdf', 'came', { folder: '/home/anna/other' });
  file('/home/anna/inbox/gone.pdf', 'came');
  file('/home/anna/inbox/gone.pdf', 'gone');
  clock.advance(5000);
  assertEquals(sent(), ['/home/anna/inbox/a.pdf', '/home/anna/inbox/B.PDF'], 'a change, another name, another folder and a file gone are not sent');

  const changes = engineOf(INBOX.replace("match: '*.pdf'", 'changes: true'));
  changes.engine.file({ folder: '/home/anna/inbox', path: '/home/anna/inbox/notes.txt', change: 'written', at: changes.clock.now });
  changes.clock.advance(5000);
  assertEquals(changes.logs.map((log) => log.value), ['/home/anna/inbox/notes.txt'], 'with changes, a file written again is sent');
  changes.engine.file({ folder: '/home/anna/inbox', path: '/home/anna/inbox/late.txt', change: 'came', at: changes.clock.now });
  changes.engine.stop();
  changes.clock.advance(5000);
  assertEquals(changes.logs.length, 1, 'nothing is sent once stopped');
});
