/**
 * What the sources make of what devices say, and what they send for a command: pure, no broker.
 */

import { assertEquals, assertExists } from '@std/assert';
import { createHaDiscovery } from '../lib/sources/ha-discovery.ts';
import { createShelly } from '../lib/sources/shelly.ts';
import type { Update } from '../lib/sources/types.ts';
import { esphomeConfigs, esphomeStates, shellyButton, shellyPlug, templatedConfig } from './fixtures.ts';

const of = <K extends Update['kind']>(updates: Update[], kind: K) => updates.filter((update): update is Extract<Update, { kind: K }> => update.kind === kind);

Deno.test('ha-discovery: an ESPHome sensor', async (t) => {
  const source = createHaDiscovery();
  const announced = esphomeConfigs.flatMap((message) => source.decode(message.topic, message.payload, true));

  await t.step('is a device named by its node id, with its maker and MAC', () => {
    const device = of(announced, 'device')[0];
    assertEquals([device.device, device.label, device.manufacturer, device.model, device.firmware, device.mac], [
      'hall-sensor',
      'hall-sensor',
      'Espressif',
      'esp32dev',
      '2025.10.0 (ESPHome)',
      'a4cf12000001',
    ]);
  });

  await t.step('each announcement is an entity, named by its object id', () => {
    const entities = of(announced, 'entity').map((entity) => [entity.entity, entity.entityKind, entity.unit, entity.deviceClass, entity.settable]);
    assertEquals(entities, [
      ['temperature', 'sensor', '°C', 'temperature', false],
      ['motion', 'binary', undefined, 'motion', false],
      ['relay', 'switch', undefined, undefined, true],
    ]);
  });

  await t.step('the bridge is asked to hear each state topic and the availability topic', () => {
    const topics = new Set(of(announced, 'subscribe').map((update) => update.topic));
    for (const topic of ['hall-sensor/sensor/temperature/state', 'hall-sensor/binary_sensor/motion/state', 'hall-sensor/switch/relay/state', 'hall-sensor/status']) {
      assertEquals(topics.has(topic), true, topic);
    }
  });

  await t.step('states are numbers and on or off; availability is online', () => {
    const updates = esphomeStates.flatMap((message) => source.decode(message.topic, message.payload, false));
    assertEquals(of(updates, 'online'), [{ kind: 'online', device: 'hall-sensor', online: true }]);
    assertEquals(of(updates, 'state').map((state) => [state.entity, state.value]), [['temperature', 21.4], ['motion', false], ['relay', true]]);
    assertEquals(of(source.decode('hall-sensor/sensor/temperature/state', 'unavailable', false), 'state')[0].value, null);
  });

  await t.step('a retained state says so', () => {
    assertEquals(of(source.decode('hall-sensor/sensor/temperature/state', '21.5', true), 'state')[0].retained, true);
  });

  await t.step('the switch is switched with its own payloads', () => {
    assertEquals(source.encode({ device: 'hall-sensor', entity: 'relay', value: 'on' }), [{ topic: 'hall-sensor/switch/relay/command', payload: 'ON' }]);
    assertEquals(source.encode({ device: 'hall-sensor', entity: 'relay', value: 'off' }), [{ topic: 'hall-sensor/switch/relay/command', payload: 'OFF' }]);
    assertEquals(source.encode({ device: 'hall-sensor', entity: 'temperature', value: 'on' }), undefined);
  });

  await t.step('an empty announcement retires the entity and stops reading its topic', () => {
    assertEquals(source.decode(esphomeConfigs[1].topic, '', false), [{ kind: 'retire', device: 'hall-sensor', entity: 'motion' }]);
    assertEquals(source.decode('hall-sensor/binary_sensor/motion/state', 'ON', false), []);
  });

  await t.step('forgetting the device clears its retained announcements', () => {
    const clears = source.forget('hall-sensor');
    assertEquals(clears.map((publish) => [publish.topic, publish.payload, publish.retain]), [
      [esphomeConfigs[0].topic, '', true],
      [esphomeConfigs[2].topic, '', true],
    ]);
    assertEquals(source.decode('hall-sensor/sensor/temperature/state', '22', false), []);
    assertEquals(source.encode({ device: 'hall-sensor', entity: 'relay', value: 'on' }), undefined);
  });
});

Deno.test('ha-discovery: templates, a shared state topic, and what it cannot read', async (t) => {
  const source = createHaDiscovery();

  await t.step('a value template reads a field of a JSON state', () => {
    const announced = source.decode(templatedConfig.topic, templatedConfig.payload, true);
    assertEquals(of(announced, 'entity')[0].supported, true);
    assertEquals(of(source.decode('zigbee2mqtt/bedroom', JSON.stringify({ humidity: 48.26, temperature: 19.1 }), false), 'state')[0].value, 48.3);
  });

  await t.step('a template it does not understand marks the entity unsupported, and says why', () => {
    const config = JSON.stringify({ name: 'Doubled', stat_t: 'x/doubled', val_tpl: '{{ value_json.a * 2 }}', dev: { ids: 'x1', name: 'x' } });
    const entity = of(source.decode('homeassistant/sensor/x/doubled/config', config, true), 'entity')[0];
    assertEquals([entity.supported, entity.problem?.startsWith('template not understood')], [false, true]);
    assertEquals(source.notes().some((note) => note.startsWith('x/doubled:')), true);
  });

  await t.step('a component it does not read is skipped and noted', () => {
    const config = JSON.stringify({ name: 'Heating', dev: { ids: 'x1', name: 'x' } });
    assertEquals(source.decode('homeassistant/climate/x/heating/config', config, true), []);
    assertEquals(source.notes().includes('x/heating: component climate is not read'), true);
  });

  await t.step('a number says its range and step, and is set with the number as its payload', () => {
    const config = JSON.stringify({ name: 'Target', stat_t: 'x/target', cmd_t: 'x/target/set', min: 5, max: 30, step: 0.5, dev: { ids: 'x1', name: 'x' } });
    const entity = of(source.decode('homeassistant/number/x/target/config', config, true), 'entity')[0];
    assertEquals([entity.entityKind, entity.min, entity.max, entity.step, entity.settable], ['number', 5, 30, 0.5, true]);
    assertEquals(source.encode({ device: 'x', entity: 'target', value: '21.5' }), [{ topic: 'x/target/set', payload: '21.5' }]);
  });

  await t.step('a retained press is not a press', () => {
    const config = JSON.stringify({ name: 'Doorbell', stat_t: 'x/doorbell', evt_typ: ['press'], dev: { ids: 'x1', name: 'x' } });
    source.decode('homeassistant/event/x/doorbell/config', config, true);
    assertEquals(source.decode('x/doorbell', JSON.stringify({ event_type: 'press' }), true), []);
    assertEquals(source.decode('x/doorbell', JSON.stringify({ event_type: 'press' }), false), [{ kind: 'event', device: 'x', entity: 'doorbell', value: 'press' }]);
  });
});

Deno.test('shelly: a plug and a four-button input', async (t) => {
  const source = createShelly({ src: 'ein-automation-test' });

  await t.step('a status makes the prefix a device, which is asked what it is', () => {
    const updates = source.decode(shellyPlug.switchStatus.topic, shellyPlug.switchStatus.payload, false);
    assertEquals(of(updates, 'device')[0].device, 'hall-plug');
    const asked = of(updates, 'publish').map((update) => JSON.parse(update.publish.payload).method);
    assertEquals(asked, ['Shelly.GetDeviceInfo', 'Shelly.GetStatus']);
    assertEquals(of(updates, 'publish')[0].publish.topic, 'hall-plug/rpc');
  });

  await t.step('the switch is an entity that can be set, beside its power, energy and temperature', () => {
    const fresh = createShelly({ src: 'ein-automation-test' });
    const updates = fresh.decode(shellyPlug.switchStatus.topic, shellyPlug.switchStatus.payload, false);
    assertEquals(of(updates, 'entity').map((entity) => [entity.entity, entity.entityKind, entity.unit ?? '', entity.settable]), [
      ['switch-0', 'switch', '', true],
      ['switch-0-power', 'sensor', 'W', false],
      ['switch-0-voltage', 'sensor', 'V', false],
      ['switch-0-current', 'sensor', 'A', false],
      ['switch-0-energy', 'sensor', 'Wh', false],
      ['switch-0-temperature', 'sensor', '°C', false],
    ]);
    assertEquals(of(updates, 'state').map((state) => [state.entity, state.value]), [
      ['switch-0', true],
      ['switch-0-power', 12.3],
      ['switch-0-voltage', 231.2],
      ['switch-0-current', 0.06],
      ['switch-0-energy', 1520.5],
      ['switch-0-temperature', 31.2],
    ]);
  });

  await t.step('a change notification carries only what changed', () => {
    const updates = source.decode(shellyPlug.powerChange.topic, shellyPlug.powerChange.payload, false);
    assertEquals(of(updates, 'state').map((state) => [state.entity, state.value]), [['switch-0-power', 20.5]]);
  });

  await t.step('its answer about itself names and describes the device', () => {
    const asked = JSON.parse(of(createShelly({ src: 's' }).decode(shellyPlug.online.topic, 'true', true), 'publish')[0].publish.payload).id;
    const fresh = createShelly({ src: 's' });
    fresh.decode(shellyPlug.online.topic, 'true', true);
    const answer = shellyPlug.deviceInfo('s', asked);
    const device = of(fresh.decode(answer.topic, answer.payload, false), 'device')[0];
    assertExists(device);
    assertEquals([device.label, device.manufacturer, device.model, device.firmware, device.mac], ['Hall plug', 'Shelly', 'S3PL-00112EU', '1.4.4', 'a8032ab12345']);
  });

  await t.step('online and offline', () => {
    assertEquals(of(source.decode('hall-plug/online', 'false', true), 'online'), [{ kind: 'online', device: 'hall-plug', online: false }]);
  });

  await t.step('a press is a button entity and an event; a retained one is not', () => {
    const updates = source.decode(shellyButton.press.topic, shellyButton.press.payload, false);
    assertEquals(of(updates, 'entity').map((entity) => [entity.device, entity.entity, entity.entityKind]), [['porch-button', 'input-0', 'button']]);
    assertEquals(of(updates, 'event'), [{ kind: 'event', device: 'porch-button', entity: 'input-0', value: 'single' }]);
    assertEquals(of(source.decode(shellyButton.longPress.topic, shellyButton.longPress.payload, false), 'event')[0].value, 'long');
    assertEquals(of(source.decode(shellyButton.press.topic, shellyButton.press.payload, true), 'event'), []);
  });

  await t.step('the switch is set over JSON-RPC', () => {
    const set = source.encode({ device: 'hall-plug', entity: 'switch-0', value: 'off' });
    assertEquals(set?.[0].topic, 'hall-plug/rpc');
    const call = JSON.parse(set![0].payload);
    assertEquals([call.src, call.method, call.params], ['ein-automation-test', 'Switch.Set', { id: 0, on: false }]);
    assertEquals(JSON.parse(source.encode({ device: 'hall-plug', entity: 'switch-0', value: 'on' })![0].payload).params, { id: 0, on: true });
    assertEquals(source.encode({ device: 'hall-plug', entity: 'switch-0-power', value: 'on' }), undefined);
  });

  await t.step('what is not a Shelly is left alone', () => {
    assertEquals(source.decode('hall-sensor/status', 'online', true), []);
    assertEquals(source.decode('garage/status/door', JSON.stringify({ open: true }), false), []);
    assertEquals(source.decode('garage/online', 'yes', false), []);
  });
});
