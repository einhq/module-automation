/**
 * The small rules: which templates are read, how names are made, when a reading is published, how an
 * average is rounded.
 */

import { assertEquals } from '@std/assert';
import { parseTarget } from '../lib/paths.ts';
import { labelOf, slug } from '../lib/slug.ts';
import { bucketValue } from '../lib/store.ts';
import { compileTemplate } from '../lib/sources/template.ts';
import { decide } from '../lib/throttle.ts';
import { parseDuration, parseMoment } from '../lib/time.ts';

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

Deno.test('names: slugs are safe as a node name and a key segment', () => {
  assertEquals(slug('Hall sensor'), 'hall-sensor');
  assertEquals(slug('shellyplus1pm-A8032AB12345'), 'shellyplus1pm-a8032ab12345');
  assertEquals(slug('Kök.lampa/2'), 'kok-lampa-2');
  assertEquals(slug('--'), '');
  assertEquals(labelOf('switch-0-power'), 'Switch 0 power');
});

Deno.test('names: a target is a device, or a device and an entity, by name or path', () => {
  assertEquals(parseTarget('hall-plug'), { device: 'hall-plug' });
  assertEquals(parseTarget('hall-plug/switch-0'), { device: 'hall-plug', entity: 'switch-0' });
  assertEquals(parseTarget('/archive/devices/hall-plug/switch-0'), { device: 'hall-plug', entity: 'switch-0' });
  assertEquals(parseTarget('a/b/c'), undefined);
  assertEquals(parseTarget('../etc'), undefined);
  assertEquals(parseTarget(''), undefined);
});

Deno.test('throttle: when a reading is published', () => {
  assertEquals(decide(undefined, 21, 0, 10_000), { publish: 'now' });
  assertEquals(decide({ value: 21, at: 0 }, 21, 60_000, 10_000), { publish: 'no' });
  assertEquals(decide({ value: 21, at: 0 }, 22, 4_000, 10_000), { publish: 'later', at: 10_000 });
  assertEquals(decide({ value: 21, at: 0 }, 22, 10_000, 10_000), { publish: 'now' });
  assertEquals(decide({ value: true, at: 0 }, false, 1, 10_000), { publish: 'now' });
  assertEquals(decide({ value: 'single', at: 0 }, 'double', 1, 10_000), { publish: 'now' });
});

Deno.test('times: a duration, and a moment as a time or as that long ago', () => {
  assertEquals(parseDuration('15m'), 900_000);
  assertEquals(parseDuration('1.5h'), 5_400_000);
  assertEquals(parseDuration('7d'), 604_800_000);
  assertEquals(parseDuration('7 days'), undefined);
  const now = Date.UTC(2026, 0, 5);
  assertEquals(parseMoment('24h', now)?.toISOString(), '2026-01-04T00:00:00.000Z');
  assertEquals(parseMoment('2026-01-01T12:00:00Z', now)?.toISOString(), '2026-01-01T12:00:00.000Z');
  assertEquals(parseMoment('yesterday', now), undefined);
});

Deno.test('an average is given to five significant digits, every other aggregate as it is', () => {
  assertEquals(bucketValue(20.666666666666668, 'avg'), 20.667);
  assertEquals(bucketValue(0.000123456, 'avg'), 0.00012346);
  assertEquals(bucketValue(230.4, 'avg'), 230.4);
  assertEquals(bucketValue(20.666666666666668, 'max'), 20.666666666666668);
  assertEquals(bucketValue(true, 'avg'), true);
});
