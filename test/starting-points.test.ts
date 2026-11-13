/**
 * A starting point's slots, as `automation-new --set` fills them: each names nodes the starting point
 * has, a filled one runs with the devices given, `none` takes out what the slot says, and a slot
 * left unset or given a wrong value is said.
 */

import { assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import { parse } from '@std/yaml';
import type { AutomationSpec } from '../lib/api.ts';
import { fillExample, yamlOf } from '../lib/automation-commands.ts';
import { EXAMPLES } from '../lib/automations/examples.ts';
import { readAutomation } from '../lib/automations/graph.ts';
import { Simulation } from '../ui/automation/simulation.ts';

const MIN = 60_000;
const START = Date.UTC(2026, 10, 9, 6, 0);
const example = (name: string) => EXAMPLES.find((each) => each.name === name)!;
const said = (sim: Simulation, kind: string) => sim.entries.filter((entry) => entry.kind === kind).map((entry) => entry.text).reverse();
/** The filled graph as `automation-new` writes it, read back as the engine reads it. */
const simulationOf = (spec: AutomationSpec) => {
  const { automation, problems } = readAutomation(parse(yamlOf(spec)));
  assertEquals(problems, []);
  return new Simulation(automation!, 'UTC', START);
};

Deno.test('starting points: every slot sets settings of nodes the starting point has, and drops only those', () => {
  for (const each of EXAMPLES) {
    const nodes = (parse(each.yaml) as AutomationSpec).nodes;
    for (const slot of each.slots ?? []) {
      for (const field of [...slot.sets.map((set) => set.split('.')[0]), ...slot.drops ?? []]) {
        assertEquals(field in nodes, true, `${each.name} ${slot.name}: ${field}`);
      }
    }
  }
});

Deno.test('starting points: a motion light with its devices set switches the lamp given at the motion given', async () => {
  const { spec, problems } = fillExample(example('motion-light'), [
    'motion=/dev/porch-sensor/motion',
    'lamp=porch-lamp/switch-0',
    'light-level=porch-sensor/lux',
    'dark-below=10',
    'off-after=2m',
  ]);
  assertEquals(problems, []);
  assertEquals(spec.description, example('motion-light').description);
  assertEquals(spec.nodes.dark.below, 10);
  const sim = simulationOf(spec);
  sim.prime(new Map([['porch-sensor/lux', { value: 5, at: START - MIN }]]), new Map());
  sim.feed('porch-sensor/motion', true);
  await sim.settled();
  sim.feed('porch-sensor/motion', false);
  sim.advance(2 * MIN);
  await sim.settled();
  assertEquals(said(sim, 'control'), ['would set porch-lamp/switch-0 to on', 'would set porch-lamp/switch-0 to off']);
});

Deno.test('starting points: none takes out an optional sensor with its wires, or a setting', async () => {
  const { spec, problems } = fillExample(example('motion-light'), ['motion=porch-sensor/motion', 'lamp=porch-lamp/switch-0', 'light-level=none'], 'The porch lamp at motion');
  assertEquals(problems, []);
  assertEquals([spec.description, 'lux' in spec.nodes, 'dark' in spec.nodes], ['The porch lamp at motion', false, false]);
  const sim = simulationOf(spec);
  sim.feed('porch-sensor/motion', true);
  await sim.settled();
  assertEquals(said(sim, 'control'), ['would set porch-lamp/switch-0 to on'], 'on at any light');

  const every = fillExample(example('button-toggle'), ['button=porch-button/input-0', 'lamp=porch-lamp/switch-0', 'press=none']).spec;
  assertEquals('is' in every.nodes.press, false);
});

Deno.test('starting points: a heater only switched off leaves out what would switch it on, and runs', async () => {
  const { spec, problems } = fillExample(example('heater'), ['temperature=hall-sensor/temperature', 'heater=heater-plug/switch-0', 'on-below=none', 'off-above=24']);
  assertEquals(problems, []);
  assertEquals(Object.keys(spec.nodes).sort(), ['heater-off', 'temperature', 'warm', 'warm-a-while']);
  const sim = simulationOf(spec);
  sim.feed('hall-sensor/temperature', 25);
  sim.advance(5 * MIN);
  await sim.settled();
  assertEquals(said(sim, 'control'), ['would set heater-plug/switch-0 to off']);
});

Deno.test('starting points: a folder in a line is quoted for the shell', () => {
  const { spec } = fillExample(example('inbox'), ['folder=/home/anna/scans', "to=/home/anna/Anna's papers"]);
  assertStringIncludes(String(spec.nodes['file-it'].run), `mv "$VALUE" '/home/anna/Anna'\\''s papers'/`);
});

Deno.test('starting points: an unset device, an unknown slot or a wrong value is said', () => {
  const { problems } = fillExample(example('motion-light'), ['motion=porch-sensor/motion']);
  assertEquals(problems.map((problem) => problem.message), [
    'lamp is not set: --set lamp=<device>/<endpoint>',
    'light-level is not set: --set light-level=<device>/<endpoint>, or none',
  ]);
  assertThrows(() => fillExample(example('motion-light'), ['bulb=porch-lamp/switch-0']), Error, 'it has motion, lamp');
  assertThrows(() => fillExample(example('motion-light'), ['lamp=porch-lamp']), Error, 'lamp takes <device>/<endpoint>');
  assertThrows(() => fillExample(example('heater'), ['on-below=cold']), Error, 'on-below takes a number');
  assertThrows(() => fillExample(example('tour'), ['lamp=porch-lamp/switch-0']), Error, 'tour has no slots');
});
