/**
 * What the sources make of what devices say, and what they send for a command: pure, no broker.
 */

import { assertEquals, assertExists } from '@std/assert';
import { createHaDiscovery } from '../lib/sources/ha-discovery.ts';
import { createShelly } from '../lib/sources/shelly.ts';
import { createShellyGen1 } from '../lib/sources/shelly-gen1.ts';
import type { Update } from '../lib/sources/types.ts';
import {
  esphomeConfigs,
  esphomeStates,
  shellyButton,
  shellyColorLight,
  shellyCover,
  shellyGen1Light,
  shellyGen1Plug,
  shellyGen1Roller,
  shellyPlug,
  templatedConfig,
} from './fixtures.ts';

const of = <K extends Update['kind']>(updates: Update[], kind: K) => updates.filter((update): update is Extract<Update, { kind: K }> => update.kind === kind);

Deno.test('ha-discovery: an ESPHome sensor', async (t) => {
  const source = createHaDiscovery();
  const announced = esphomeConfigs.flatMap((message) => source.decode(message.topic, message.payload, true));

  await t.step('is a device named by its node id, with its maker, MAC and web page', () => {
    const device = of(announced, 'device')[0];
    assertEquals([device.device, device.label, device.manufacturer, device.model, device.firmware, device.mac, device.url], [
      'hall-sensor',
      'hall-sensor',
      'Espressif',
      'esp32dev',
      '2025.10.0 (ESPHome)',
      'a4cf12000001',
      'http://192.0.2.22',
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

  await t.step('its Wi-Fi status says where its web page is', () => {
    const updates = source.decode('hall-plug/status/wifi', JSON.stringify({ sta_ip: '192.0.2.20', status: 'got ip', rssi: -60 }), true);
    assertEquals(of(updates, 'device').map((device) => device.url), ['http://192.0.2.20/']);
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

Deno.test('shelly: a colour light and a cover', async (t) => {
  const source = createShelly({ src: 's' });
  const callOf = (device: string, entity: string, value: string) => {
    const set = source.encode({ device, entity, value });
    return set ? (({ method, params }) => ({ method, params }))(JSON.parse(set[0].payload)) : undefined;
  };

  await t.step('a colour light has its brightness, colour and white, each settable', () => {
    const updates = source.decode(shellyColorLight.status.topic, shellyColorLight.status.payload, false);
    assertEquals(of(updates, 'entity').map((entity) => [entity.entity, entity.entityKind, entity.settable, entity.max ?? '']), [
      ['rgbw-0', 'light', true, ''],
      ['rgbw-0-brightness', 'number', true, 100],
      ['rgbw-0-color', 'text', true, ''],
      ['rgbw-0-white', 'number', true, 255],
      ['rgbw-0-power', 'sensor', false, ''],
    ]);
    assertEquals(of(updates, 'state').map((state) => [state.entity, state.value]), [
      ['rgbw-0', true],
      ['rgbw-0-brightness', 40],
      ['rgbw-0-color', '#ff8000'],
      ['rgbw-0-white', 10],
      ['rgbw-0-power', 6.1],
    ]);
  });

  await t.step("each is set with the light's own call", () => {
    assertEquals(callOf('desk-lamp', 'rgbw-0', 'on'), { method: 'RGBW.Set', params: { id: 0, on: true } });
    assertEquals(callOf('desk-lamp', 'rgbw-0-brightness', '75'), { method: 'RGBW.Set', params: { id: 0, brightness: 75 } });
    assertEquals(callOf('desk-lamp', 'rgbw-0-color', '#00ff7f'), { method: 'RGBW.Set', params: { id: 0, rgb: [0, 255, 127] } });
    assertEquals(callOf('desk-lamp', 'rgbw-0-color', '10, 20, 30'), { method: 'RGBW.Set', params: { id: 0, rgb: [10, 20, 30] } });
    assertEquals(callOf('desk-lamp', 'rgbw-0-color', 'blue'), undefined);
    assertEquals(callOf('desk-lamp', 'rgbw-0-brightness', 'bright'), undefined);
    assertEquals(callOf('desk-lamp', 'rgbw-0-power', '1'), undefined);
  });

  await t.step('a cover has its position to set, its state, and open, close and stop', () => {
    const updates = source.decode(shellyCover.status.topic, shellyCover.status.payload, false);
    assertEquals(of(updates, 'entity').map((entity) => [entity.entity, entity.entityKind, entity.settable]), [
      ['cover-0-position', 'number', true],
      ['cover-0-state', 'sensor', false],
      ['cover-0-open', 'action', true],
      ['cover-0-close', 'action', true],
      ['cover-0-stop', 'action', true],
      ['cover-0-power', 'sensor', false],
    ]);
    assertEquals(of(updates, 'state').map((state) => state.entity), ['cover-0-position', 'cover-0-state', 'cover-0-power']);
    assertEquals(callOf('kitchen-blind', 'cover-0-position', '60'), { method: 'Cover.GoToPosition', params: { id: 0, pos: 60 } });
    assertEquals(callOf('kitchen-blind', 'cover-0-close', 'press'), { method: 'Cover.Close', params: { id: 0 } });
    assertEquals(callOf('kitchen-blind', 'cover-0-stop', 'press'), { method: 'Cover.Stop', params: { id: 0 } });
  });
});

Deno.test('shelly-gen1: a colour light and a roller', async (t) => {
  const light = shellyGen1Light;
  const roller = shellyGen1Roller;

  await t.step('a light in colour mode has its gain as its brightness, its colour and its temperature', () => {
    const source = createShellyGen1();
    assertEquals(of(source.decode(light.light.topic, light.light.payload, true), 'entity').map((entity) => [entity.entity, entity.entityKind, entity.settable]), [[
      'light-0',
      'light',
      true,
    ]]);
    const updates = source.decode(light.status.topic, light.status.payload, true);
    assertEquals(of(updates, 'entity').map((entity) => [entity.entity, entity.entityKind, entity.settable]), [
      ['light-0-brightness', 'number', true],
      ['light-0-color', 'text', true],
      ['light-0-color-temperature', 'number', true],
    ]);
    assertEquals(of(updates, 'state').map((state) => [state.entity, state.value]), [
      ['light-0-brightness', 70],
      ['light-0-color', '#0080ff'],
      ['light-0-color-temperature', 4750],
    ]);
  });

  await t.step('it is set on its set topic, its brightness as the gain while in colour mode', () => {
    const source = createShellyGen1();
    source.decode(light.status.topic, light.status.payload, true);
    const name = 'shellycolorbulb-a1b2c3d4e5f7';
    const set = `shellies/${light.id}/light/0/set`;
    assertEquals(source.encode({ device: name, entity: 'light-0', value: 'off' }), [{ topic: `shellies/${light.id}/light/0/command`, payload: 'off' }]);
    assertEquals(source.encode({ device: name, entity: 'light-0-brightness', value: '50' }), [{ topic: set, payload: JSON.stringify({ gain: 50 }) }]);
    assertEquals(source.encode({ device: name, entity: 'light-0-color', value: '#ff0000' }), [{
      topic: set,
      payload: JSON.stringify({ mode: 'color', red: 255, green: 0, blue: 0 }),
    }]);
    assertEquals(source.encode({ device: name, entity: 'light-0-color-temperature', value: '3000' }), [{ topic: set, payload: JSON.stringify({ temp: 3000 }) }]);
    source.decode(light.status.topic, JSON.stringify({ ison: true, mode: 'white', brightness: 30, temp: 3000 }), false);
    assertEquals(source.encode({ device: name, entity: 'light-0-brightness', value: '50' }), [{ topic: set, payload: JSON.stringify({ brightness: 50 }) }]);
    assertEquals(source.decode(set, JSON.stringify({ gain: 50 }), false), [], 'its own command is not a reading');
  });

  await t.step('a roller has its state, a position it does not know yet, and open, close and stop', () => {
    const source = createShellyGen1();
    const name = 'shellyswitch25-a1b2c3d4e5f8';
    const state = source.decode(roller.state.topic, roller.state.payload, true);
    assertEquals(of(state, 'entity').map((entity) => [entity.entity, entity.entityKind, entity.settable]), [
      ['roller-0-state', 'sensor', false],
      ['roller-0-open', 'action', true],
      ['roller-0-close', 'action', true],
      ['roller-0-stop', 'action', true],
    ]);
    assertEquals(of(state, 'state').map((update) => [update.entity, update.value]), [['roller-0-state', 'stop']]);
    const position = source.decode(roller.position.topic, roller.position.payload, true);
    assertEquals([of(position, 'entity')[0].entityKind, of(position, 'state')[0].value], ['number', null]);
    assertEquals(source.encode({ device: name, entity: 'roller-0-open', value: 'press' }), [{ topic: `shellies/${roller.id}/roller/0/command`, payload: 'open' }]);
    assertEquals(source.encode({ device: name, entity: 'roller-0-position', value: '40' }), [{ topic: `shellies/${roller.id}/roller/0/command/pos`, payload: '40' }]);
    assertEquals(source.decode(`shellies/${roller.id}/roller/0/command/pos`, '40', false), [], 'its own command is not a reading');
  });
});

Deno.test('shelly-gen1: a first generation plug', async (t) => {
  const plug = shellyGen1Plug;
  const device = 'shellyplug-s-a1b2c3d4e5f6';

  await t.step('its announcement makes it a device, with its model, firmware, MAC and web page', () => {
    const source = createShellyGen1();
    const updates = source.decode(plug.announce.topic, plug.announce.payload, false);
    assertEquals(of(updates, 'device'), [{
      kind: 'device',
      device,
      label: plug.id,
      manufacturer: 'Shelly',
      model: 'Plug S',
      firmware: '20221027-101131/v1.12.1-ga9117d3',
      mac: 'a1:b2:c3:d4:e5:f6',
      url: 'http://192.0.2.10/',
    }]);
    assertEquals(of(updates, 'publish'), [], 'one that announced is not asked to');
  });

  await t.step('its relay can be set, its power is in W and its energy in Wh', () => {
    const source = createShellyGen1();
    source.decode(plug.announce.topic, plug.announce.payload, false);
    const relay = source.decode(plug.relay.topic, plug.relay.payload, true);
    assertEquals(of(relay, 'entity').map((entity) => [entity.entity, entity.entityKind, entity.settable]), [['relay-0', 'switch', true]]);
    assertEquals(of(relay, 'state'), [{ kind: 'state', device, entity: 'relay-0', value: true, retained: true }]);
    assertEquals(of(source.decode(plug.power.topic, plug.power.payload, false), 'state')[0].value, 8.46);
    const energy = source.decode(plug.energy.topic, plug.energy.payload, false);
    assertEquals([of(energy, 'entity')[0].unit, of(energy, 'state')[0].value], ['Wh', 2]);
    const temperature = source.decode(plug.temperature.topic, plug.temperature.payload, false);
    assertEquals([of(temperature, 'entity')[0].category, of(temperature, 'state')[0].value], ['diagnostic', 27.9]);
    assertEquals(source.decode(plug.relay.topic, plug.relay.payload, false).filter((update) => update.kind !== 'state'), [], 'an entity is announced once');
  });

  await t.step('a device heard before it announced is asked to, once', () => {
    const source = createShellyGen1();
    const updates = source.decode(plug.online.topic, plug.online.payload, true);
    assertEquals([of(updates, 'device')[0].device, of(updates, 'online')[0].online], [device, true]);
    assertEquals(of(updates, 'publish').map((update) => update.publish), [{ topic: `shellies/${plug.id}/command`, payload: 'announce' }]);
    assertEquals(of(source.decode(plug.power.topic, plug.power.payload, false), 'publish'), []);
  });

  await t.step('on and off go to its command topic; nothing else does', () => {
    const source = createShellyGen1();
    source.decode(plug.announce.topic, plug.announce.payload, false);
    assertEquals(source.encode({ device, entity: 'relay-0', value: 'off' }), [plug.command]);
    assertEquals(source.encode({ device, entity: 'relay-0-power', value: '1' }), undefined);
    assertEquals(source.encode({ device: 'someone-else', entity: 'relay-0', value: 'on' }), undefined);
    assertEquals(source.decode(plug.command.topic, plug.command.payload, false), [], 'its own command is not a reading');
  });

  await t.step('a press is an event, and a retained one is not news', () => {
    const source = createShellyGen1();
    source.decode(plug.announce.topic, plug.announce.payload, false);
    const topic = `shellies/${plug.id}/input_event/0`;
    const pressed = source.decode(topic, JSON.stringify({ event: 'SS', event_cnt: 3 }), false);
    assertEquals([of(pressed, 'entity')[0].entityKind, of(pressed, 'event')[0].value], ['button', 'double']);
    assertEquals(of(source.decode(topic, JSON.stringify({ event: 'S', event_cnt: 4 }), true), 'event'), []);
  });
});
