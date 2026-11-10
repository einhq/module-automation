/** An automation tried out in the editor: fed by hand on a clock of its own, its actions said, not done. */

import { assertEquals } from '@std/assert';
import { parse } from '@std/yaml';
import { EXAMPLES } from '../lib/automations/examples.ts';
import { readAutomation } from '../lib/automations/graph.ts';
import { Simulation } from '../ui/automation/simulation.ts';

const MIN = 60_000;
/** A Monday, 06:00 in UTC. */
const START = Date.UTC(2026, 10, 9, 6, 0);

const simulationOf = (yaml: string) => {
  const { automation, problems } = readAutomation(parse(yaml));
  assertEquals(problems, []);
  return new Simulation(automation!, 'UTC', START);
};
const example = (name: string) => EXAMPLES.find((each) => each.name === name)!.yaml;
const said = (sim: Simulation, kind: string) => sim.entries.filter((entry) => entry.kind === kind).map((entry) => entry.text).reverse();

Deno.test('simulation: the motion light switches the lamp on and, once the clock has moved on, off', async () => {
  const sim = simulationOf(example('motion-light'));
  sim.prime(new Map([['hall-sensor/illuminance', { value: 12, at: START - MIN }]]), new Map());
  sim.feed('hall-sensor/motion', true);
  await sim.settled();
  assertEquals(said(sim, 'control'), ['would set hall-lamp/switch-0 to on']);
  assertEquals(sim.values.get('hall-lamp/switch-0'), true, 'the simulated lamp took it');

  sim.feed('hall-sensor/motion', false);
  sim.advance(4 * MIN);
  await sim.settled();
  assertEquals(said(sim, 'control').length, 1, 'not yet: five minutes');
  assertEquals(sim.nextTimer(), START + 5 * MIN);
  sim.advance(MIN);
  await sim.settled();
  assertEquals(said(sim, 'control'), ['would set hall-lamp/switch-0 to on', 'would set hall-lamp/switch-0 to off']);
  assertEquals(sim.values.get('hall-lamp/switch-0'), false);
});

Deno.test('simulation: a toggle flips what the simulated device holds; a button and a link feed it', async () => {
  const sim = simulationOf(example('button-toggle'));
  sim.press('try-it');
  await sim.settled();
  sim.feed('porch-button/input-0', 'single', true);
  await sim.settled();
  sim.feed('porch-button/input-0', 'long', true);
  await sim.settled();
  assertEquals(said(sim, 'control'), ['would toggle hall-lamp/switch-0, to on', 'would toggle hall-lamp/switch-0, to off']);

  const linked = simulationOf('nodes: {in: {type: link-in, name: door, to: [log]}, log: {type: debug}}');
  linked.sendLink('door', 'open');
  assertEquals(said(linked, 'debug'), ['"open" from door']);
});

Deno.test('simulation: a shell line is said, not run, and a clock goes off as the time passes it', async () => {
  const sim = simulationOf('nodes: {morning: {type: clock, at: "06:30", to: [run]}, run: {type: shell, run: echo hi}}');
  assertEquals(sim.nextClock('morning'), START + 30 * MIN);
  sim.engine.tick(START);
  sim.advanceTo(sim.nextClock('morning')!);
  await sim.settled();
  assertEquals(said(sim, 'clock'), ['it is "06:30"']);
  assertEquals(said(sim, 'shell'), ['would run: echo hi (VALUE=06:30)']);
  assertEquals(sim.nextClock('morning'), START + 30 * MIN + 1440 * MIN);
});

Deno.test('simulation: the log follows each node that sent, and says why one held a value back', async () => {
  const sim = simulationOf(example('motion-light'));
  sim.prime(new Map([['hall-sensor/illuminance', { value: 80, at: START - MIN }]]), new Map());
  assertEquals(sim.entries, [], 'priming is quiet');
  sim.feed('hall-sensor/motion', true);
  await sim.settled();
  assertEquals(sim.entries.map((entry) => `${entry.node}: ${entry.text}`).reverse(), [
    'hall-sensor/motion: reads true',
    'motion: sent true',
    'linger: sent true on true',
    'dark-and-moving: held back false: the same as it last sent',
  ]);
  assertEquals(said(sim, 'control'), [], 'too light for the lamp');
});
