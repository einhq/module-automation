/**
 * The bridge in a booted EiN against a broker of the test's own: devices become nodes, readings
 * reach their history and anyone's queue, commands reach the device as whoever may give them,
 * and a reconnect replays nothing new.
 */

import { assertEquals, assertExists } from '@std/assert';
import { createTestContext, type ShellClient } from '@ein/testing';
import type { AutomationStatus, DeviceHistory, DeviceInfo, DeviceSummary } from '@automation/api';
import { esphomeConfigs, esphomeStates, shellyButton, shellyPlug } from './fixtures.ts';
import { startStubBroker } from './stub-broker.ts';

/** Ask until `check` holds, or fail with what it last saw. */
const until = async <T>(what: string, read: () => Promise<T>, check: (value: T) => boolean, timeoutMs = 10_000): Promise<T> => {
  const end = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < end) {
    try {
      last = await read();
      if (check(last)) return last;
    } catch {
      // not there yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${what}: still ${JSON.stringify(last)}`);
};

Deno.test({ name: 'automation bridge', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const broker = startStubBroker();
  const testCtx = createTestContext({
    modules: ['automation'],
    boot: true,
    env: { CFG_AUTOMATION_MQTT_URL: broker.url, CFG_AUTOMATION_MIN_INTERVAL: '0' },
  });
  await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const clients: ShellClient[] = [admin];

  try {
    for (const name of ['anna', 'bo']) await admin.execString(`user-create ${name} && user-passwd ${name} --new-password hunter2`);
    const signIn = async (username: string) => {
      const client = await testCtx.server.createShellClient({ username, password: 'hunter2' });
      clients.push(client);
      return client;
    };
    const anna = await signIn('anna');
    const bo = await signIn('bo');

    await t.step('the bridge connects, and the automation group exists', async () => {
      const status = await until('connected', () => admin.execJson<AutomationStatus>('automation-status'), (status) => status.connected);
      assertEquals(status.sources, ['ha-discovery', 'shelly']);
      assertEquals((await admin.exec('group-exists automation')).success, true);
    });

    await t.step('an ESPHome sensor becomes a device with its entities and their values', async () => {
      for (const message of [...esphomeConfigs, ...esphomeStates]) broker.publish(message.topic, message.payload, { retain: message.retain });
      const info = await until(
        'hall-sensor',
        () => anna.execJson<DeviceInfo>('device-show hall-sensor'),
        (info) => info.entityList.filter((entity) => entity.last).length === 3,
      );
      assertEquals([info.label, info.source, info.online, info.mac], ['hall-sensor', 'ha-discovery', true, 'a4cf12000001']);
      assertEquals(info.entityList.map((entity) => [entity.name, entity.kind, entity.last?.value, entity.settable]), [
        ['motion', 'binary', false, false],
        ['relay', 'switch', true, true],
        ['temperature', 'sensor', 21.4, false],
      ]);
      assertEquals(info.main, { entity: 'temperature', label: 'Temperature', value: 21.4, unit: '°C' });
    });

    await t.step("the device is the automation group's; its set node the users group's", async () => {
      const device = (await admin.execJson<{ props: { gid: number } }>('stat /archive/devices/hall-sensor')).props;
      const set = (await admin.execJson<{ props: { gid: number } }>('stat /archive/devices/hall-sensor/relay/set')).props;
      const automation = await admin.execJson<{ gid: number }>('group-info automation');
      const users = await admin.execJson<{ gid: number }>('group-info users');
      assertEquals([device.gid, set.gid], [automation.gid, users.gid]);
    });

    await t.step('a reading is kept in the history and reaches a queue someone bound to its key', async () => {
      await anna.execString("mkqueue -k 'automation.state.hall-sensor.#' /home/anna/hall");
      broker.publish('hall-sensor/sensor/temperature/state', '22.0', { retain: true });
      const history = await until(
        'history',
        () => anna.execJson<DeviceHistory>('device-history hall-sensor/temperature'),
        (history) => history.readings.length === 2,
      );
      assertEquals([history.unit, history.readings.map((reading) => reading.value)], ['°C', [21.4, 22]]);
      const queued = await until('queue', () => anna.execString('queue-peek /home/anna/hall'), (text) => text.includes('22'));
      assertEquals(queued.includes('°C'), true);
    });

    await t.step('a Shelly plug and its power', async () => {
      broker.publish(shellyPlug.online.topic, shellyPlug.online.payload, { retain: true });
      broker.publish(shellyPlug.switchStatus.topic, shellyPlug.switchStatus.payload);
      const asked = await until('GetDeviceInfo', async () => broker.published.filter((message) => message.topic === 'hall-plug/rpc'), (asked) => asked.length >= 2);
      const request = JSON.parse(asked[0].payload);
      const answer = shellyPlug.deviceInfo(request.src, request.id);
      broker.publish(answer.topic, answer.payload);
      const info = await until('hall-plug', () => anna.execJson<DeviceInfo>('device-show hall-plug'), (info) => info.model === 'S3PL-00112EU');
      assertEquals([info.manufacturer, info.online, info.main?.entity, info.main?.value], ['Shelly', true, 'switch-0-power', 12.3]);
      broker.publish(shellyPlug.powerChange.topic, shellyPlug.powerChange.payload);
      await until('power', () => anna.execJson<DeviceHistory>('device-history hall-plug/switch-0-power'), (history) => history.readings.at(-1)?.value === 20.5);
    });

    await t.step('a button press is an event on the bus', async () => {
      await bo.execString("mkqueue -k 'automation.event.#' /home/bo/presses");
      broker.publish(shellyButton.press.topic, shellyButton.press.payload);
      broker.publish(shellyButton.longPress.topic, shellyButton.longPress.payload);
      const presses = await until('presses', () => bo.execString('queue-peek /home/bo/presses'), (text) => text.includes('long'));
      assertEquals(presses.includes('single'), true);
    });

    await t.step('device-set sends what the device understands, as anyone in the users group', async () => {
      await anna.execString('device-set hall-plug/switch-0 off');
      const call = await until(
        'Switch.Set',
        async () => broker.published.filter((message) => message.topic === 'hall-plug/rpc').map((message) => JSON.parse(message.payload)),
        (calls) => calls.some((call) => call.method === 'Switch.Set'),
      );
      assertEquals(call.find((each) => each.method === 'Switch.Set').params, { id: 0, on: false });
      await bo.execString('device-set hall-sensor/relay toggle');
      await until(
        'relay command',
        async () => broker.published.filter((message) => message.topic === 'hall-sensor/switch/relay/command'),
        (sent) => sent.at(-1)?.payload === 'OFF',
      );
    });

    await t.step('a value an entity does not take, and an entity that cannot be set, are refused', async () => {
      assertEquals((await anna.exec('device-set hall-plug/switch-0 dim')).success, false);
      assertEquals((await anna.exec('device-set hall-sensor/temperature 20')).success, false);
    });

    await t.step("who may set an entity is its set node's mode", async () => {
      await admin.execString('chmod 640 /archive/devices/hall-plug/switch-0/set');
      assertEquals((await anna.exec('device-set hall-plug/switch-0 on')).success, false);
      await admin.execString('chmod 660 /archive/devices/hall-plug/switch-0/set');
      await anna.execString('device-set hall-plug/switch-0 on');
    });

    await t.step('naming a device is for the automation group', async () => {
      assertEquals((await anna.exec("device-label hall-plug 'Hall lamp'")).success, false);
      await admin.execString('group-add-member automation anna');
      const member = await signIn('anna');
      await member.execString("device-label hall-plug 'Hall lamp'");
      const devices = await anna.execJson<DeviceSummary[]>('devices');
      assertEquals(devices.find((device) => device.name === 'hall-plug')?.label, 'Hall lamp');
    });

    await t.step('a reconnect replays the retained states, and the history keeps nothing new', async () => {
      const before = (await admin.execJson<DeviceHistory>('device-history hall-sensor/temperature')).readings.length;
      broker.dropClients();
      await until('reconnected', () => admin.execJson<AutomationStatus>('automation-status'), (status) => status.connected && broker.clients() > 0);
      broker.publish('hall-sensor/sensor/temperature/state', '22.0', { retain: true });
      await new Promise((resolve) => setTimeout(resolve, 500));
      assertEquals((await admin.execJson<DeviceHistory>('device-history hall-sensor/temperature')).readings.length, before);
    });

    await t.step('forgetting a device removes it and stops the broker replaying its announcements', async () => {
      const member = clients.at(-1)!;
      await member.execString('device-forget hall-sensor');
      assertEquals((await admin.exec('stat /archive/devices/hall-sensor')).success, false);
      for (const message of esphomeConfigs) assertEquals(broker.retained.has(message.topic), false, message.topic);
    });

    await t.step('the status counts what the bridge heard', async () => {
      const status = await admin.execJson<AutomationStatus>('automation-status');
      assertExists(status.since);
      assertEquals(status.connected, true);
      assertEquals(status.messages > 10, true);
      assertEquals((await admin.execString('JSON_OUTPUT=0 automation-status --brief')).includes('devices'), true);
    });
  } finally {
    for (const client of clients) client.close();
    await testCtx.teardown();
    await broker.close();
  }
});
