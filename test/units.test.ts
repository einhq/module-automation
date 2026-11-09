/**
 * The small rules: which templates are read, how labels are made, how an automation's durations read.
 */

import { assertEquals } from '@std/assert';
import { labelOf } from '../lib/sources/label.ts';
import { compileTemplate } from '../lib/sources/template.ts';
import { parseDuration } from '../lib/time.ts';

const run = (template: string, payload: string): unknown => {
  const compiled = compileTemplate(template);
  if (typeof compiled !== 'function') throw new Error(compiled.problem);
  return compiled(payload);
};

Deno.test('templates: the subset that is read', () => {
  assertEquals(run('{{ value }}', '21.4'), '21.4');
  assertEquals(run('{{ value | float }}', '21.4'), 21.4);
  assertEquals(run('{{ value_json.temperature }}', '{"temperature": 19.5}'), 19.5);
  assertEquals(run("{{ value_json['air quality'].pm25 | int }}", '{"air quality": {"pm25": 12.8}}'), 12);
  assertEquals(run('{{ value_json.sensors[1] | round(1) }}', '{"sensors": [1, 2.46]}'), 2.5);
  assertEquals(run('{{ value_json.state | lower }}', '{"state": "ON"}'), 'on');
  assertEquals(run('{{ value_json.missing.deeper }}', '{"other": 1}'), undefined);
  assertEquals(run('{{ value_json.a }}', 'not json'), undefined);
});

Deno.test('templates: anything else is refused with a reason', () => {
  for (const template of ['{{ value_json.a * 2 }}', '{% if value %}on{% endif %}', '{{ states("sensor.x") }}', '{{ value | timestamp_local }}']) {
    const compiled = compileTemplate(template);
    assertEquals(typeof compiled === 'object' && compiled.problem.includes('not understood'), true, template);
  }
});

Deno.test('labels: an id read as words', () => {
  assertEquals(labelOf('switch-0-power'), 'Switch 0 power');
  assertEquals(labelOf('input:1'), 'Input 1');
  assertEquals(labelOf('--'), '--');
});

Deno.test('times: a duration', () => {
  assertEquals(parseDuration('15m'), 900_000);
  assertEquals(parseDuration('1.5h'), 5_400_000);
  assertEquals(parseDuration('7d'), 604_800_000);
  assertEquals(parseDuration('7 days'), undefined);
});
