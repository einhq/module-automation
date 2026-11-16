/**
 * The small rules: how an automation's durations read, and what a virtual device's config says.
 */

import { assertEquals, assertThrows } from '@std/assert';
import { parseDuration } from '../lib/time.ts';
import { parseVirtualConfig } from '../lib/virtual.ts';

Deno.test('times: a duration', () => {
  assertEquals(parseDuration('15m'), 900_000);
  assertEquals(parseDuration('1.5h'), 5_400_000);
  assertEquals(parseDuration('7d'), 604_800_000);
  assertEquals(parseDuration('7 days'), undefined);
});

Deno.test('virtual devices: readings and controls from their config, and what is refused with a reason', () => {
  const { readings, controls } = parseVirtualConfig({
    read: 'temperature=avg hall-sensor/temperature kitchen-sensor/temperature; moving=any hall-sensor/motion',
    set: 'away=bool\nsetpoint=number 5..30 0.5 °C; mode=enum eco comfort off; note=text; chime=momentary',
  });
  assertEquals(readings, [
    { name: 'temperature', fn: 'avg', sources: ['hall-sensor/temperature', 'kitchen-sensor/temperature'] },
    { name: 'moving', fn: 'any', sources: ['hall-sensor/motion'] },
  ]);
  assertEquals(controls, [
    { name: 'away', schema: { type: 'bool' } },
    { name: 'setpoint', schema: { type: 'number', min: 5, max: 30, step: 0.5 }, unit: '°C' },
    { name: 'mode', schema: { type: 'enum', options: ['eco', 'comfort', 'off'] } },
    { name: 'note', schema: { type: 'text' } },
    { name: 'chime', schema: { type: 'momentary' } },
  ]);
  assertEquals(parseVirtualConfig({}), { readings: [], controls: [] });
  for (
    const [config, problem] of [
      [{ read: 'temperature=median a/b' }, 'takes one of avg'],
      [{ read: 'temperature=avg' }, 'names no <device>/<endpoint>'],
      [{ read: 'temperature=avg hall-sensor' }, "reads 'hall-sensor'"],
      [{ read: 'Temperature=avg a/b' }, 'lower-case'],
      [{ set: 'away=switch' }, 'bool, number, enum, text or momentary'],
      [{ set: 'away=bool on' }, 'takes nothing after it'],
      [{ set: 'mode=enum' }, 'takes its options'],
      [{ set: 'level=number 1..2 1 % extra' }, "not 'extra'"],
      [{ read: 'x=avg a/b', set: 'x=bool' }, 'x is named twice'],
    ] as const
  ) {
    assertThrows(() => parseVirtualConfig(config as Record<string, string>), Error, problem);
  }
});
