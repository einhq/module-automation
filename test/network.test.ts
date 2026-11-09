/**
 * What the network listener's hosts are named as, how they are matched to devices under /dev, what
 * adopting a Shelly sends it, and the IPP and Cast messages the polled drivers speak: no broker, and
 * no network but this machine's loopback.
 */

import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import type { NetworkHost } from '../lib/api.ts';
import { adoptShelly, type Fetch } from '../lib/network/adopt.ts';
import { foundDevices, NetworkHosts } from '../lib/network/found.ts';
import { identify, webPageOf } from '../lib/network/identify.ts';
import { parseIppResponse, printerAttributesRequest } from '../lib/network/ipp.ts';
import { decodeCastMessage, encodeCastMessage } from '../lib/network/cast.ts';
import { changesOf, createPolledDrivers, reach } from '../lib/network/polled.ts';
import { ippResponse, startSnmpAgent } from './fixtures.ts';
import { snmpWalk } from '../lib/network/snmp.ts';

const SEEN = '2026-11-09T08:00:00.000Z';

const host = (ip: string, more: Partial<NetworkHost>): NetworkHost => ({ ip, names: [], seen: SEEN, mdns: [], ssdp: [], ...more });

const shellyPlus = host('192.168.1.20', {
  mac: 'a8:03:2a:b1:23:45',
  names: ['shellyplus1pm-a8032ab12345.local'],
  mdns: [
    { type: '_shelly._tcp', instance: 'shellyplus1pm-a8032ab12345', port: 80, txt: { gen: '2', app: 'Plus1PM', ver: '1.4.4' } },
    { type: '_http._tcp', instance: 'shellyplus1pm-a8032ab12345', port: 80, txt: { gen: '2' } },
  ],
});
const shellyGen1 = host('192.168.1.21', {
  names: ['shellyplug-s-c45bbe000001.local'],
  mdns: [{ type: '_http._tcp', instance: 'shellyplug-s-C45BBE000001', port: 80, txt: {} }],
});
const esphome = host('192.168.1.22', {
  names: ['hall-sensor.local'],
  mdns: [{ type: '_esphomelib._tcp', instance: 'hall-sensor', port: 6053, txt: { friendly_name: 'Hall sensor', board: 'esp32dev', version: '2025.10.0' } }],
});
const printer = host('192.168.1.23', {
  names: ['printer.local'],
  mdns: [{ type: '_ipp._tcp', instance: 'Office printer', port: 631, txt: { ty: 'Inkjet 7200' } }],
});
const nas = host('192.168.1.24', {
  ssdp: [{ st: 'upnp:rootdevice', friendlyName: 'Backup box', manufacturer: 'Synology', modelName: 'DS216se' }],
});
const readynas = host('192.168.1.27', {
  names: ['attic-nas.local'],
  mdns: [
    { type: '_smb._tcp', instance: 'attic-nas (CIFS)', port: 445, txt: {} },
    { type: '_http._tcp', instance: 'FrontView on attic-nas', port: 80, txt: { path: '/admin/' } },
    { type: '_readynas._tcp', instance: 'ReadyNAS Discovery [attic-nas]', port: 9, txt: { vendor: 'NETGEAR', model: 'ReadyNAS Ultra 4', serial: 'TEST0001', channels: '4' } },
  ],
});
const share = host('192.168.1.28', { names: ['old-box.local'], mdns: [{ type: '_afpovertcp._tcp', instance: 'old-box (AFP)', port: 548, txt: {} }] });
const unknown = host('192.168.1.25', {
  ssdp: [{ st: 'upnp:rootdevice', friendlyName: 'Thing', manufacturer: 'Acme', modelName: 'Widget 2' }],
});

Deno.test('identify', async (t) => {
  await t.step('a Shelly of the second generation is one adopt points at the broker', () => {
    const identity = identify(shellyPlus);
    assertEquals([identity.kind, identity.vendor, identity.model, identity.firmware, identity.addable, identity.adopt], [
      'shelly',
      'Shelly',
      'Plus1PM',
      '1.4.4',
      true,
      'shelly',
    ]);
  });
  await t.step('one of the first is known by its HTTP service alone', () => {
    const identity = identify(shellyGen1);
    assertEquals([identity.kind, identity.model, identity.adopt], ['shelly-gen1', 'shellyplug-s', 'shelly-gen1']);
  });
  await t.step('ESPHome is added over MQTT, by hand, with its friendly name', () => {
    const identity = identify(esphome);
    assertEquals([identity.kind, identity.label, identity.model, identity.addable, identity.adopt], ['esphome', 'Hall sensor', 'esp32dev', true, undefined]);
  });
  await t.step('a printer is added over IPP, a NAS as whether it answers', () => {
    assertEquals([identify(printer).kind, identify(printer).model, identify(printer).adopt], ['printer', 'Inkjet 7200', 'ipp']);
    assertEquals([identify(nas).kind, identify(nas).label, identify(nas).model, identify(nas).adopt], ['storage', 'Backup box', 'DS216se', 'network']);
  });
  await t.step('a ReadyNAS is named by its host, with the maker, model and serial its own record gives', () => {
    const identity = identify(readynas);
    assertEquals([identity.kind, identity.label, identity.vendor, identity.model, identity.serial], ['storage', 'attic-nas', 'NETGEAR', 'ReadyNAS Ultra 4', 'TEST0001']);
  });
  await t.step('a file share is named by its host, not by the share', () => {
    assertEquals(identify(share).label, 'old-box');
  });
  await t.step('a Cast speaker is added over Cast', () => {
    const speaker = host('192.168.1.26', { mdns: [{ type: '_googlecast._tcp', instance: 'Google-Home-Mini-1', txt: { fn: 'Kitchen speaker', md: 'Google Home Mini' } }] });
    assertEquals([identify(speaker).kind, identify(speaker).label, identify(speaker).adopt, identify(speaker).class], ['cast', 'Kitchen speaker', 'cast', 'speaker']);
  });
  await t.step('what no pattern knows is named from its UPnP description, and says whether it answers', () => {
    assertEquals(identify(unknown), {
      kind: 'other',
      addable: true,
      adopt: 'network',
      connect: 'Added, it says whether it answers and how fast.',
      vendor: 'Acme',
      label: 'Thing',
      model: 'Widget 2',
    });
  });
});

Deno.test("a host's web page is its HTTP service, else a printer's admin page, at its address", () => {
  assertEquals(webPageOf(shellyPlus), 'http://192.168.1.20/');
  assertEquals(webPageOf(host('192.168.1.23', { mdns: [{ type: '_http._tcp', instance: 'x', port: 8080, txt: {} }] })), 'http://192.168.1.23:8080/');
  assertEquals(webPageOf(host('192.168.1.23', { mdns: [{ type: '_ipp._tcp', instance: 'x', txt: { adminurl: 'http://printer.local.' } }] })), 'http://192.168.1.23/');
  assertEquals(webPageOf(nas), undefined);
  assertEquals(webPageOf(readynas), 'http://192.168.1.27/admin/', 'the page its path record names');
});

Deno.test('the network listener on the broker', async (t) => {
  const network = new NetworkHosts();
  const say = (id: string, value: NetworkHost | '') => network.hear(`ein/discovery/host/${id}`, value === '' ? '' : JSON.stringify(value));

  await t.step('keeps each host by its id, and the listener status', () => {
    assertEquals(say('a8032ab12345', shellyPlus), true);
    say('192.168.1.22', esphome);
    say('192.168.1.23', printer);
    network.hear('ein/discovery/status', JSON.stringify({ round: SEEN, hosts: 3, broker: '192.168.1.2:1883' }));
    assertEquals([...network.hosts.keys()], ['a8032ab12345', '192.168.1.22', '192.168.1.23']);
    assertEquals(network.status, { round: SEEN, broker: '192.168.1.2:1883' });
  });

  await t.step('lets a host go on an empty message, and leaves the others’ topics alone', () => {
    say('192.168.1.23', '');
    assertEquals(network.hosts.has('192.168.1.23'), false);
    assertEquals(network.hear('shellies/plug/relay/0', 'on'), false);
  });

  await t.step('matches hosts to devices by hardware address or by the name they answer to', () => {
    const found = foundDevices(network, [{ name: 'shellyplus1pm-a8032ab12345' }, { name: 'other', mac: 'A4CF12000001' }], new Set());
    assertEquals(found.broker, '192.168.1.2:1883');
    assertEquals(found.devices.map((each) => [each.id, each.device]), [['192.168.1.22', undefined], ['a8032ab12345', 'shellyplus1pm-a8032ab12345']]);
    const byMac = foundDevices(network, [{ name: 'plus', mac: 'A8-03-2A-B1-23-45' }], new Set(['192.168.1.22']));
    assertEquals(byMac.devices.map((each) => [each.id, each.device, each.ignored]), [['192.168.1.22', undefined, true], ['a8032ab12345', 'plus', false]]);
  });
});

Deno.test('adoptShelly', async (t) => {
  const broker = { address: '192.168.1.2:1883', user: 'device', password: 'secret' };
  const recorder = (status = 200) => {
    const asked: { url: string; body?: unknown }[] = [];
    const fetcher: Fetch = (url, init) => {
      asked.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      return Promise.resolve(new Response(JSON.stringify({ id: 1, result: { restart_required: true } }), { status }));
    };
    return { asked, fetcher };
  };

  await t.step('the second generation: Mqtt.SetConfig with notifications on, then a restart', async () => {
    const { asked, fetcher } = recorder();
    await adoptShelly(fetcher, '192.168.1.20', 'shelly', broker);
    assertEquals(asked.map((each) => (each.body as { method: string }).method), ['Mqtt.SetConfig', 'Shelly.Reboot']);
    assertEquals((asked[0].body as { params: { config: Record<string, unknown> } }).params.config, {
      enable: true,
      server: '192.168.1.2:1883',
      user: 'device',
      pass: 'secret',
      rpc_ntf: true,
      status_ntf: true,
      enable_control: true,
    });
  });

  await t.step('the first: its settings over a query, then a restart', async () => {
    const { asked, fetcher } = recorder();
    await adoptShelly(fetcher, '192.168.1.21', 'shelly-gen1', broker);
    assertEquals(asked.map((each) => each.url), [
      'http://192.168.1.21/settings?mqtt_enable=true&mqtt_server=192.168.1.2%3A1883&mqtt_user=device&mqtt_pass=secret',
      'http://192.168.1.21/reboot',
    ]);
  });

  await t.step('a Shelly with a password of its own is refused, saying so', async () => {
    const { fetcher } = recorder(401);
    await assertRejects(() => adoptShelly(fetcher, '192.168.1.20', 'shelly', broker), Error, 'password of its own');
  });
});

Deno.test('IPP', async (t) => {
  await t.step('the request names the printer and what is asked of it', () => {
    const text = new TextDecoder().decode(printerAttributesRequest('ipp://192.168.1.23:631/ipp/print'));
    assertEquals(['ipp://192.168.1.23:631/ipp/print', 'marker-levels', 'printer-state'].every((each) => text.includes(each)), true);
  });
  await t.step('an answer is read as its attributes, a name given once for all its values', () => {
    const attributes = parseIppResponse(ippResponse([
      [0x23, 'printer-state', [4]],
      [0x44, 'printer-state-reasons', ['marker-supply-low-warning']],
      [0x42, 'marker-names', ['black cartridge', 'tri-color cartridge']],
      [0x21, 'marker-levels', [64, -2]],
    ]));
    assertEquals(attributes, {
      'printer-state': [4],
      'printer-state-reasons': ['marker-supply-low-warning'],
      'marker-names': ['black cartridge', 'tri-color cartridge'],
      'marker-levels': [64, -2],
    });
  });
  await t.step('a refusal is an error', () => {
    const refused = ippResponse([]);
    refused[2] = 0x04;
    assertThrows(() => parseIppResponse(refused), Error, 'IPP status 0x0400');
  });
});

Deno.test('a Cast message survives its encoding', () => {
  const framed = encodeCastMessage('receiver-0', 'urn:x-cast:com.google.cast.receiver', { type: 'GET_STATUS', requestId: 1 });
  assertEquals(new DataView(framed.buffer).getUint32(0), framed.length - 4);
  assertEquals(decodeCastMessage(framed.subarray(4)), {
    source: 'sender-ein',
    namespace: 'urn:x-cast:com.google.cast.receiver',
    payload: { type: 'GET_STATUS', requestId: 1 },
  });
});

Deno.test('a host answers when it accepts or refuses, and not when it is silent', async () => {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const open = (listener.addr as Deno.NetAddr).port;
  const closed = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const refused = (closed.addr as Deno.NetAddr).port;
  closed.close();
  try {
    assertEquals(typeof await reach('127.0.0.1', [open]), 'number');
    assertEquals(typeof await reach('127.0.0.1', [refused]), 'number');
  } finally {
    listener.close();
  }
  await assertRejects(() => reach('192.0.2.1', [9]), Error, 'does not answer');
});

Deno.test('a poll announces each endpoint once, and says the device is online', () => {
  const polled = {
    entities: [{ kind: 'entity' as const, device: 'printer', entity: 'state', label: 'state', entityKind: 'sensor' as const, settable: false, supported: true }],
    values: { state: 'idle' },
  };
  assertEquals(changesOf('printer', polled, new Set()).map((change) => change.kind), ['entity', 'state', 'online']);
  assertEquals(changesOf('printer', polled, new Set(['state'])).map((change) => change.kind), ['state', 'online']);
});

Deno.test({ name: 'the snmp driver reads a NAS: uptime, load, memory, its volumes and temperatures', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const storage = '1.3.6.1.2.1.25.2.3.1';
  const agent = startSnmpAgent([
    ['1.3.6.1.2.1.1.1.0', 'string', 'Linux attic-nas 2.6.37 x86_64'],
    ['1.3.6.1.2.1.1.3.0', 'ticks', 864_000_00],
    ['1.3.6.1.4.1.2021.10.1.3.1', 'string', '0.42'],
    // Physical memory (RAM), a volume, and /dev, which is the system's own.
    [`${storage}.2.1`, 'oid', '1.3.6.1.2.1.25.2.1.2'],
    [`${storage}.3.1`, 'string', 'Physical memory'],
    [`${storage}.4.1`, 'int', 1024],
    [`${storage}.5.1`, 'int', 4_000_000],
    [`${storage}.6.1`, 'int', 1_000_000],
    [`${storage}.2.31`, 'oid', '1.3.6.1.2.1.25.2.1.4'],
    [`${storage}.3.31`, 'string', '/c'],
    [`${storage}.4.31`, 'int', 4096],
    [`${storage}.5.31`, 'int', 1_000_000],
    [`${storage}.6.31`, 'int', 900_000],
    [`${storage}.2.32`, 'oid', '1.3.6.1.2.1.25.2.1.4'],
    [`${storage}.3.32`, 'string', '/dev'],
    [`${storage}.4.32`, 'int', 4096],
    [`${storage}.5.32`, 'int', 1_000_000],
    [`${storage}.6.32`, 'int', 0],
    ['1.3.6.1.4.1.2021.13.16.2.1.2.1', 'string', 'CPU'],
    ['1.3.6.1.4.1.2021.13.16.2.1.3.1', 'int', 47_500],
  ]);
  const port = await agent.ready;
  try {
    const snmp = createPolledDrivers(fetch).find((driver) => driver.name === 'snmp')!;
    await t.step("a poll names each reading once, a volume by its mount, the system's own mounts left out", async () => {
      const polled = await snmp.poll({ name: 'attic-nas', ip: '127.0.0.1', snmpPort: port });
      assertEquals(polled.entities.map((each) => each.entity), ['uptime', 'load', 'memory-used', 'c-used', 'c-free', 'cpu-temperature']);
      assertEquals(polled.values, { uptime: 10, load: 0.42, 'memory-used': 25, 'c-used': 90, 'c-free': 0.4, 'cpu-temperature': 47.5 });
    });
    await t.step('a walk answers every object under an OID, across GETBULK batches', async () => {
      const walked = await snmpWalk({ host: '127.0.0.1', port, community: 'public' }, storage);
      assertEquals(walked.length, 15);
      assertEquals(walked[0], { oid: `${storage}.2.1`, type: 'OID', value: '1.3.6.1.2.1.25.2.1.2' });
    });
    await t.step('another community is not answered, and says so', async () => {
      await assertRejects(() => snmp.poll({ name: 'attic-nas', ip: '127.0.0.1', snmpPort: port, community: 'wrong' }), Error, "with the community 'wrong'");
    });
  } finally {
    agent.close();
  }
});
