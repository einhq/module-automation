/**
 * The bridge in a booted EiN against a broker of the test's own: devices it hears become core's
 * devices under /dev with endpoints of the right types, their readings are kept there and reach
 * anyone's queue, a write to a control reaches the device as whoever may give it, a forgotten device
 * stays forgotten, and a reconnect adds nothing. What the network listener says on the same broker
 * is what automation-found lists, matched to those devices.
 */

import { assertEquals, assertExists, assertStringIncludes } from '@std/assert';
import type { DeviceHistory, DeviceInfo, DriverSummary } from '@ein/api';
import { createTestContext, type ShellClient, testCommands } from '@ein/testing';
import type { AdoptAnswer, AutomationStatus, FoundAnswer, FoundDetail, NetworkHost } from '@automation/api';
import { esphomeConfigs, esphomeStates, ippResponse, shellyButton, shellyColorLight, shellyGen1Plug, shellyPlug } from './fixtures.ts';
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
    await admin.execString('group-add-member devices anna');
    const signIn = async (username: string) => {
      const client = await testCtx.server.createShellClient({ username, password: 'hunter2' });
      clients.push(client);
      return client;
    };
    const anna = await signIn('anna');
    const bo = await signIn('bo');

    await t.step('the bridge connects and registers a driver for each source', async () => {
      const status = await until('connected', () => admin.execJson<AutomationStatus>('automation-status'), (status) => status.connected);
      assertEquals(status.drivers, ['ha-discovery', 'shelly', 'shelly-gen1', 'network', 'ipp', 'snmp', 'cast', 'http', 'rtsp', 'onvif']);
      const drivers = await anna.execJson<DriverSummary[]>('devices --drivers');
      assertEquals(drivers.filter((driver) => driver.module === 'automation').map((driver) => [driver.name, driver.running]), [
        ['cast', true],
        ['ha-discovery', true],
        ['http', true],
        ['ipp', true],
        ['network', true],
        ['onvif', true],
        ['rtsp', true],
        ['shelly', true],
        ['shelly-gen1', true],
        ['snmp', true],
        ['virtual', true],
      ]);
    });

    await t.step('an ESPHome sensor becomes a device under /dev, its entities endpoints with their readings', async () => {
      for (const message of [...esphomeConfigs, ...esphomeStates]) broker.publish(message.topic, message.payload, { retain: message.retain });
      const info = await until(
        'hall-sensor',
        () => anna.execJson<DeviceInfo>('device-show hall-sensor'),
        (info) => info.endpointList.filter((endpoint) => endpoint.last).length === 3 && info.online === true,
      );
      assertEquals([info.path, info.label, info.driver, info.driverRunning, info.class, info.manufacturer, info.mac], [
        '/dev/hall-sensor',
        'hall-sensor',
        'ha-discovery',
        true,
        'sensor',
        'Espressif',
        'a4cf12000001',
      ]);
      assertEquals(info.endpointList.map((endpoint) => [endpoint.name, endpoint.type, endpoint.schema?.type, endpoint.last?.value, endpoint.writable]), [
        ['motion', 'log', undefined, false, true],
        ['relay', 'control', 'bool', true, true],
        ['temperature', 'log', undefined, 21.4, true],
      ]);
      assertEquals(info.main, { endpoint: 'temperature', label: 'Temperature', value: 21.4, unit: '°C' });
    });

    await t.step('a reading is kept on its endpoint and reaches a queue the administrator bound to its key', async () => {
      await testCommands(anna).shouldFailWith("mkqueue -k 'dev.hall-sensor.#' /home/anna/hall", 'routingKeys');
      await admin.execString("mkqueue -k 'dev.hall-sensor.#' /home/admin/hall");
      broker.publish('hall-sensor/sensor/temperature/state', '22.0', { retain: true });
      const history = await until(
        'history',
        () => anna.execJson<DeviceHistory>('device-history hall-sensor/temperature'),
        (history) => history.readings.length === 2,
      );
      assertEquals([history.unit, history.readings.map((reading) => reading.value)], ['°C', [21.4, 22]]);
      const queued = await until('queue', () => admin.execString('queue-peek /home/admin/hall'), (text) => text.includes('"value":22'));
      assertStringIncludes(queued, '"endpoint":"temperature"');
    });

    await t.step('a Shelly plug: its switch a control, its power a reading', async () => {
      broker.publish(shellyPlug.online.topic, shellyPlug.online.payload, { retain: true });
      broker.publish(shellyPlug.switchStatus.topic, shellyPlug.switchStatus.payload);
      const asked = await until('GetDeviceInfo', async () => broker.published.filter((message) => message.topic === 'hall-plug/rpc'), (asked) => asked.length >= 2);
      const request = JSON.parse(asked[0].payload);
      const answer = shellyPlug.deviceInfo(request.src, request.id);
      broker.publish(answer.topic, answer.payload);
      const info = await until('hall-plug', () => anna.execJson<DeviceInfo>('device-show hall-plug'), (info) => info.model === 'S3PL-00112EU');
      assertEquals([info.driver, info.class, info.manufacturer, info.firmware, info.online, info.main?.endpoint, info.main?.value], [
        'shelly',
        'plug',
        'Shelly',
        '1.4.4',
        true,
        'switch-0-power',
        12.3,
      ]);
      const endpoints = new Map(info.endpointList.map((endpoint) => [endpoint.name, endpoint]));
      assertEquals([endpoints.get('switch-0')?.type, endpoints.get('switch-0')?.last?.value], ['control', true]);
      assertEquals([endpoints.get('switch-0-temperature')?.type, endpoints.get('switch-0-temperature')?.category], ['log', 'diagnostic']);
      broker.publish(shellyPlug.powerChange.topic, shellyPlug.powerChange.payload);
      await until('power', () => anna.execJson<DeviceHistory>('device-history hall-plug/switch-0-power'), (history) => history.readings.at(-1)?.value === 20.5);
    });

    await t.step('a button press is an event on the bus', async () => {
      await admin.execString("mkqueue -k 'dev.#' /home/admin/presses");
      broker.publish(shellyButton.press.topic, shellyButton.press.payload);
      broker.publish(shellyButton.longPress.topic, shellyButton.longPress.payload);
      const presses = await until('presses', () => admin.execString('queue-peek -n 50 /home/admin/presses'), (text) => text.includes('long'));
      assertStringIncludes(presses, '"value":"single"');
      assertStringIncludes(presses, '"event":true');
      const button = await anna.execJson<DeviceInfo>('device-show porch-button');
      assertEquals([button.class, button.endpointList.map((endpoint) => [endpoint.name, endpoint.type, endpoint.events])], ['button', [['input-0', 'log', true]]]);
    });

    await t.step('writing a control sends the device what it understands, as a member or someone it is shared with', async () => {
      await anna.execString('echo off > /dev/hall-plug/switch-0');
      const calls = broker.published.filter((message) => message.topic === 'hall-plug/rpc').map((message) => JSON.parse(message.payload));
      assertEquals(calls.find((call) => call.method === 'Switch.Set')?.params, { id: 0, on: false });
      await testCommands(bo).shouldFailWith('echo on > /dev/hall-sensor/relay', 'denied');
      await anna.execString('share-set -m u:bo:rx /dev/hall-sensor && share-set -m u:bo:rwx /dev/hall-sensor/relay');
      await bo.execString('echo on > /dev/hall-sensor/relay');
      assertEquals(broker.published.filter((message) => message.topic === 'hall-sensor/switch/relay/command').at(-1)?.payload, 'ON');
      // A toggle goes against what the relay last reported, which is still on.
      await bo.execString('echo toggle > /dev/hall-sensor/relay');
      assertEquals(broker.published.filter((message) => message.topic === 'hall-sensor/switch/relay/command').at(-1)?.payload, 'OFF');
    });

    await t.step("the device's report of its new state is the control's value", async () => {
      const off = { ...shellyPlug.powerChange, payload: JSON.stringify({ method: 'NotifyStatus', params: { 'switch:0': { id: 0, output: false } } }) };
      broker.publish(off.topic, off.payload);
      await until(
        'switch-0 off',
        () => anna.execJson<DeviceInfo>('device-show hall-plug'),
        (info) => info.endpointList.find((endpoint) => endpoint.name === 'switch-0')?.last?.value === false,
      );
    });

    await t.step("a colour light's colour is a colour control, written as #rrggbb however it was given", async () => {
      broker.publish(shellyColorLight.status.topic, shellyColorLight.status.payload);
      const info = await until(
        'desk-lamp colour',
        () => anna.execJson<DeviceInfo>('device-show desk-lamp').catch(() => undefined),
        (info) => info?.endpointList.some((endpoint) => endpoint.name === 'rgbw-0-color' && endpoint.last?.value === '#ff8000') ?? false,
      );
      assertEquals(info!.endpointList.find((endpoint) => endpoint.name === 'rgbw-0-color')?.schema, { type: 'color' });
      await anna.execString('echo 0,255,127 > /dev/desk-lamp/rgbw-0-color');
      const calls = broker.published.filter((message) => message.topic === 'desk-lamp/rpc').map((message) => JSON.parse(message.payload));
      assertEquals(calls.find((call) => call.method === 'RGBW.Set')?.params, { id: 0, rgb: [0, 255, 127] });
      assertEquals((await anna.exec('echo orange > /dev/desk-lamp/rgbw-0-color')).success, false);
    });

    await t.step('a value the control does not take, and a reading, are refused', async () => {
      assertEquals((await anna.exec('echo dim > /dev/hall-plug/switch-0')).success, false);
      assertEquals((await bo.exec('echo 20 > /dev/hall-sensor/temperature')).success, false);
    });

    await t.step('who may write a control is its mode', async () => {
      await admin.execString('chmod 644 /dev/hall-plug/switch-0');
      assertEquals((await anna.exec('echo on > /dev/hall-plug/switch-0')).success, false);
      await admin.execString('chmod 664 /dev/hall-plug/switch-0');
      await anna.execString('echo on > /dev/hall-plug/switch-0');
    });

    await t.step('a reconnect replays the retained states, and no endpoint keeps anything new', async () => {
      const before = (await admin.execJson<DeviceHistory>('device-history hall-sensor/temperature')).readings.length;
      broker.dropClients();
      await until('reconnected', () => admin.execJson<AutomationStatus>('automation-status'), (status) => status.connected && broker.clients() > 0);
      broker.publish('hall-sensor/sensor/temperature/state', '22.0', { retain: true });
      await new Promise((resolve) => setTimeout(resolve, 500));
      assertEquals((await admin.execJson<DeviceHistory>('device-history hall-sensor/temperature')).readings.length, before);
    });

    await t.step('a member of the devices group forgets a device; the broker stops replaying it, so it stays gone', async () => {
      assertEquals((await bo.exec('device-forget hall-sensor')).success, false);
      await anna.execString('device-forget hall-sensor');
      assertEquals((await admin.exec('stat /dev/hall-sensor')).success, false);
      for (const message of esphomeConfigs) assertEquals(broker.retained.has(message.topic), false, message.topic);
      broker.dropClients();
      await until('reconnected', () => admin.execJson<AutomationStatus>('automation-status'), (status) => status.connected && broker.clients() > 0);
      await new Promise((resolve) => setTimeout(resolve, 500));
      assertEquals((await admin.exec('stat /dev/hall-sensor')).success, false);
    });

    await t.step('the status counts the devices its drivers drive', async () => {
      const status = await admin.execJson<AutomationStatus>('automation-status');
      assertExists(status.since);
      assertEquals([status.connected, status.devices, status.endpoints], [true, 3, 12]);
      assertEquals(status.messages > 10, true);
      assertStringIncludes(await admin.execString('JSON_OUTPUT=0 automation-status --brief'), '3 devices, 12 endpoints');
    });

    await t.step('a first generation plug heard by its power before its relay is a plug all the same', async () => {
      const plug = shellyGen1Plug;
      broker.publish(plug.power.topic, plug.power.payload);
      const heard = await until('its power', () => admin.execJson<DeviceInfo>('device-show shellyplug-s-a1b2c3d4e5f6'), (info) => info.endpointList.length === 1);
      assertEquals(heard.class, undefined, 'the power it draws says nothing of what it is');
      broker.publish(plug.relay.topic, plug.relay.payload);
      const info = await until('a plug', () => admin.execJson<DeviceInfo>('device-show shellyplug-s-a1b2c3d4e5f6'), (info) => info.class === 'plug');
      assertEquals([info.driver, info.endpointList.map((endpoint) => [endpoint.name, endpoint.type])], ['shelly-gen1', [['relay-0', 'control'], ['relay-0-power', 'log']]]);
    });

    await t.step('the hosts the network listener heard are listed for the devices group, matched to their devices', async () => {
      const seen = new Date().toISOString();
      const hosts: Record<string, NetworkHost> = {
        a1b2c3d4e5f6: {
          ip: '192.168.1.21',
          names: ['shellyplug-s-a1b2c3d4e5f6.local'],
          seen,
          ssdp: [],
          wsd: [],
          mdns: [{ type: '_http._tcp', instance: 'shellyplug-s-A1B2C3D4E5F6', txt: {} }],
        },
        a8032ab12345: {
          ip: '192.168.1.20',
          names: ['shellyplus1pm-a8032ab12345.local'],
          seen,
          ssdp: [],
          wsd: [],
          mdns: [{ type: '_shelly._tcp', instance: 'shellyplus1pm-a8032ab12345', txt: { gen: '2', app: 'Plus1PM' } }],
        },
      };
      for (const [id, host] of Object.entries(hosts)) broker.publish(`ein/discovery/host/${id}`, JSON.stringify(host), { retain: true });
      broker.publish('ein/discovery/status', JSON.stringify({ round: seen, hosts: 2, broker: '192.168.1.2:1883' }), { retain: true });
      const all = await until('found', () => anna.execJson<FoundAnswer>('automation-found --all'), (found) => found.devices.length === 2);
      assertEquals(all.broker, '192.168.1.2:1883');
      assertEquals(all.devices.map((each) => [each.id, each.kind, each.device, each.adopt]), [
        ['a1b2c3d4e5f6', 'shelly-gen1', 'shellyplug-s-a1b2c3d4e5f6', 'shelly-gen1'],
        ['a8032ab12345', 'shelly', undefined, 'shelly'],
      ]);
      assertEquals((await anna.execJson<FoundAnswer>('automation-found --addable')).devices.map((each) => each.id), ['a8032ab12345']);
      await testCommands(bo).shouldFailWith('automation-found', 'devices group');
      await testCommands(anna).shouldFailWith('automation-adopt a1b2c3d4e5f6', 'device shellyplug-s-a1b2c3d4e5f6 already');
    });

    await t.step('an ignored host is left out until it is taken back', async () => {
      await anna.execString('automation-ignore a8032ab12345');
      assertEquals((await anna.execJson<FoundAnswer>('automation-found')).devices.length, 0);
      await anna.execString('automation-ignore a8032ab12345 --undo');
      assertEquals((await anna.execJson<FoundAnswer>('automation-found')).devices.map((each) => each.id), ['a8032ab12345']);
    });

    await t.step('a host the listener lets go is gone', async () => {
      broker.publish('ein/discovery/host/a8032ab12345', '', { retain: true });
      await until('gone', () => anna.execJson<FoundAnswer>('automation-found --all'), (found) => found.devices.length === 1);
    });

    await t.step('a host found on the network is added as a device that says whether it answers', async () => {
      const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
      const port = (listener.addr as Deno.NetAddr).port;
      try {
        const nas: NetworkHost = {
          ip: '127.0.0.1',
          mac: '00:11:32:00:00:01',
          names: ['backup-box.local'],
          seen: new Date().toISOString(),
          ssdp: [],
          wsd: [],
          mdns: [{ type: '_smb._tcp', instance: 'Backup box', port, txt: {} }],
        };
        broker.publish('ein/discovery/host/001132000001', JSON.stringify(nas), { retain: true });
        await until('heard', () => anna.execJson<FoundAnswer>('automation-found --all'), (found) => found.devices.some((each) => each.id === '001132000001'));
        const added = await anna.execJson<AdoptAnswer>('automation-adopt 001132000001');
        assertEquals([added.driver, added.device], ['network', 'backup-box']);
        const info = await until('answering', () => anna.execJson<DeviceInfo>('device-show backup-box'), (info) => info.online === true);
        assertEquals([info.driver, info.class, info.mac, info.endpointList.map((endpoint) => endpoint.name)], ['network', 'storage', '00:11:32:00:00:01', ['response-time']]);
        const found = await anna.execJson<FoundAnswer>('automation-found --all');
        assertEquals(found.devices.find((each) => each.id === '001132000001')?.device, 'backup-box');
        const detail = await anna.execJson<FoundDetail>('automation-found 001132000001');
        assertEquals(detail.host.mdns[0].instance, 'Backup box');
      } finally {
        listener.close();
      }
    });

    await t.step('a printer is added over IPP: its state, warnings and ink', async () => {
      const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, () =>
        new Response(
          ippResponse([
            [0x23, 'printer-state', [3]],
            [0x44, 'printer-state-reasons', ['marker-supply-low-warning']],
            [0x42, 'marker-names', ['black cartridge', 'tri-color cartridge']],
            [0x21, 'marker-levels', [64, -2]],
          ]),
          { headers: { 'content-type': 'application/ipp' } },
        ));
      try {
        const printer: NetworkHost = {
          ip: '127.0.0.1',
          names: ['office-printer.local'],
          seen: new Date().toISOString(),
          ssdp: [],
          wsd: [],
          mdns: [{ type: '_ipp._tcp', instance: 'Office printer', port: server.addr.port, txt: { rp: 'ipp/print', ty: 'Inkjet 7200' } }],
        };
        broker.publish('ein/discovery/host/office-printer', JSON.stringify(printer), { retain: true });
        await until('heard', () => anna.execJson<FoundAnswer>('automation-found --all'), (found) => found.devices.some((each) => each.id === 'office-printer'));
        assertEquals((await anna.execJson<AdoptAnswer>('automation-adopt office-printer')).device, 'office-printer');
        const info = await until('read', () => anna.execJson<DeviceInfo>('device-show office-printer'), (info) => info.endpointList.filter((each) => each.last).length === 3);
        assertEquals([info.driver, info.class, info.online], ['ipp', 'printer', true]);
        assertEquals(info.endpointList.map((endpoint) => [endpoint.name, endpoint.last?.value]), [
          ['black-cartridge', 64],
          ['state', 'idle'],
          ['warnings', 'marker-supply-low-warning'],
        ]);
      } finally {
        await server.shutdown();
      }
    });

    await t.step('a web API is asked at its address for the readings named in it', async () => {
      const hour = new Date();
      hour.setMinutes(0, 0, 0);
      const at = (hours: number) => new Date(hour.getTime() + hours * 3_600_000).toISOString();
      const asked: string[] = [];
      const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, (request) => {
        asked.push(`${new URL(request.url).pathname} ${request.headers.get('authorization') ?? ''}`);
        return Response.json({
          current: { temperature_2m: 7.5, weather: 'drizzle' },
          prices: [-1, 0, 1].map((hours) => ({ SEK_per_kWh: String(1 + hours / 10), time_start: at(hours), time_end: at(hours + 1) })),
        });
      });
      try {
        const url = `http://reader:pw@127.0.0.1:${server.addr.port}/forecast/{date}.json`;
        const read = 'temperature=current.temperature_2m °C; weather=current.weather; price=prices[time_start..time_end].SEK_per_kWh SEK/kWh';
        await anna.execString(`device-create Weather --driver http --config 'url=${url}' --config 'read=${read}' --config interval=1h`);
        const info = await until('read', () => anna.execJson<DeviceInfo>('device-show weather'), (info) => info.endpointList.filter((each) => each.last).length === 3);
        assertEquals([info.driver, info.class, info.online], ['http', 'sensor', true]);
        assertEquals(info.main?.endpoint, 'temperature');
        assertEquals(info.endpointList.map((endpoint) => [endpoint.name, endpoint.last?.value, endpoint.unit]), [
          ['price', 1, 'SEK/kWh'],
          ['temperature', 7.5, '°C'],
          ['weather', 'drizzle', undefined],
        ]);
        const today = new Date();
        const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        assertEquals(asked[0], `/forecast/${date}.json Basic ${btoa('reader:pw')}`);

        const refused = await anna.exec(`device-create Prices --driver http --config 'url=http://127.0.0.1/' --config 'read=price'`);
        assertEquals(refused.success, false);
        assertStringIncludes(refused.error ?? '', "http cannot ask prices: a reading is name=path [unit], not 'price'");
      } finally {
        await server.shutdown();
      }
    });
  } finally {
    for (const client of clients) client.close();
    await testCtx.teardown();
    await broker.close();
  }
});
