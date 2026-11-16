/** The editor's changes to a graph: wires drawn only where they may go, nodes added, set and removed with their wires. */

import { assertEquals } from '@std/assert';
import type { AutomationSpec } from '../lib/api.ts';
import {
  addNode,
  connect,
  disconnect,
  mayConnect,
  moveNode,
  nameProblem,
  outputsOf,
  removeNode,
  renameNode,
  setSettings,
  wiresOf,
  wouldCycle,
} from '../ui/automation/graph-edit.ts';

const spec: AutomationSpec = {
  nodes: {
    motion: { type: 'device', endpoint: 'hall-sensor/motion', to: ['linger'] },
    linger: { type: 'timer', 'off-after': '5m', to: { true: ['lamp'] } },
    lamp: { type: 'control', endpoint: 'hall-lamp/switch-0', value: 'on' },
    clock: { type: 'clock', every: '1h' },
  },
};

Deno.test('graph edit: the wires, and the outputs a node sends on', () => {
  assertEquals(wiresOf(spec), [{ from: 'motion', output: 'out', to: 'linger' }, { from: 'linger', output: 'true', to: 'lamp' }]);
  assertEquals(outputsOf(spec.nodes.linger), ['out', 'true', 'false']);
  assertEquals(outputsOf({ type: 'switch', cases: { cold: { below: 18 } } }), ['cold', 'else']);
  assertEquals(outputsOf(spec.nodes.lamp), ['out']);
});

Deno.test('graph edit: a wire is drawn where it may go, and taken out again', () => {
  const off = connect(spec, { from: 'linger', output: 'false', to: 'lamp' });
  assertEquals(off.nodes.linger.to, { true: ['lamp'], false: ['lamp'] });
  assertEquals(connect(off, { from: 'linger', output: 'false', to: 'lamp' }), off, 'a wire there already');
  assertEquals(connect(spec, { from: 'lamp', output: 'out', to: 'clock' }), spec, 'a clock takes no input');
  assertEquals(connect(spec, { from: 'lamp', output: 'out', to: 'motion' }), spec, 'a device node takes no input');
  assertEquals(connect(spec, { from: 'lamp', output: 'true', to: 'linger' }), spec, 'a control has no true');
  assertEquals(wouldCycle(spec, 'lamp', 'linger'), true);
  assertEquals(connect(spec, { from: 'lamp', output: 'out', to: 'linger' }), spec, 'round in a circle');
  assertEquals(disconnect(spec, { from: 'motion', output: 'out', to: 'linger' }).nodes.motion, { type: 'device', endpoint: 'hall-sensor/motion' });
});

Deno.test('graph edit: nodes added under a free name, moved, set, and removed with the wires into them', () => {
  const one = addNode(spec, 'delay', [10.4, 20.6]);
  const two = addNode(one.spec, 'delay', [0, 0]);
  assertEquals([one.id, two.id], ['delay', 'delay-2']);
  assertEquals(moveNode(one.spec, 'delay', [99.6, 0.2]).nodes.delay.pos, [100, 0]);
  const set = setSettings(one.spec, 'delay', { for: '30s', label: '' });
  assertEquals(set.nodes.delay, { type: 'delay', pos: [10.4, 20.6], for: '30s' });
  const gone = removeNode(spec, 'linger');
  assertEquals([Object.keys(gone.nodes), gone.nodes.motion.to], [['motion', 'lamp', 'clock'], undefined]);
  const cases = setSettings({ nodes: { s: { type: 'switch', cases: { a: { is: 1 }, b: { is: 2 } }, to: { a: ['x'], b: ['y'], else: ['z'] } } } }, 's', {
    cases: { a: { is: 1 } },
  });
  assertEquals(cases.nodes.s.to, { a: ['x'], else: ['z'] }, 'a case taken out takes its wires');
});

Deno.test('graph edit: a node renamed keeps its place, the wires into it, and the math that names it', () => {
  const graph: AutomationSpec = {
    nodes: {
      'outdoor-temp': { type: 'device', endpoint: 'garden/temperature', to: ['diff'] },
      indoor: { type: 'device', endpoint: 'hall/temperature', to: ['diff'] },
      diff: { type: 'math', expression: 'outdoor_temp - indoor + outdoor_temperature', to: ['log'] },
      log: { type: 'debug' },
    },
  };
  const renamed = renameNode(graph, 'outdoor-temp', 'garden');
  assertEquals(Object.keys(renamed.nodes), ['garden', 'indoor', 'diff', 'log']);
  assertEquals(renamed.nodes.garden.to, ['diff']);
  assertEquals(renamed.nodes.diff.expression, 'garden - indoor + outdoor_temperature', 'only the whole name');
  assertEquals(renameNode(graph, 'log', 'printed').nodes.diff.to, ['printed']);
  assertEquals(renameNode(graph, 'log', 'indoor'), graph, 'a name taken');
  assertEquals(nameProblem(graph, 'indoor'), 'indoor names another node');
  assertEquals(nameProblem(graph, '-x'), 'Letters, digits, - and _, starting with a letter or digit');
  assertEquals(nameProblem(graph, 'fine_name-2'), undefined);
});

Deno.test('graph edit: the cards a wire may be dropped on, as one being drawn shows them', () => {
  const may = (from: string, output: string) => Object.keys(spec.nodes).filter((to) => mayConnect(spec, { from, output, to }));
  assertEquals(may('linger', 'true'), [], 'lamp has it already, motion and clock take no input, and not itself');
  assertEquals(may('linger', 'false'), ['lamp']);
  assertEquals(may('lamp', 'out'), [], 'back to linger would go round');
});
