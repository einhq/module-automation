/**
 * The ONVIF client against a stub camera, and what the driver reads of its answers: a request is
 * signed with the camera's clock, a wrong password is said as such, a reference parameter goes back
 * with its namespace, and a camera's events are motion or a person seen, on or off.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { eventKind, eventState } from '../lib/cameras/onvif-driver.ts';
import { createOnvif, deviceServiceUrl, OnvifFault } from '../lib/cameras/onvif.ts';
import { find, parseXml, writeXml } from '../lib/cameras/xml.ts';
import { startOnvifCamera } from './onvif-camera.ts';

Deno.test('a camera is asked at its device service, with its own clock, and a wrong password is said', async () => {
  const camera = startOnvifCamera({ user: 'admin', password: 's3cret', clockOffsetMs: -10 * 60_000 });
  try {
    assertEquals(deviceServiceUrl('192.0.2.10:8000'), 'http://192.0.2.10:8000/onvif/device_service');
    assertEquals(deviceServiceUrl('https://192.0.2.10/onvif/device'), 'https://192.0.2.10/onvif/device');
    const onvif = createOnvif(fetch, camera.address(), 'admin', 's3cret');
    assertEquals(await onvif.info(), { manufacturer: 'Acme', model: 'Dome 4', firmware: 'v2.1', serial: 'AC0001' });
    assertEquals((await onvif.profiles()).map((profile) => [profile.token, profile.codec, profile.width, profile.ptz]), [
      ['sub', 'h264', 640, undefined],
      ['main', 'h265', 2560, { panTilt: true, zoom: true }],
    ]);
    assertEquals(await onvif.snapshotUri('main'), `http://${camera.address()}/snapshot/main.jpg`);
    const refused = await assertRejects(() => createOnvif(fetch, camera.address(), 'admin', 'wrong').info(), OnvifFault);
    assertEquals([refused.code, refused.message], ['NotAuthorized', "the camera refused admin's password"]);
  } finally {
    await camera.server.shutdown();
  }
});

Deno.test('XML is read by local names, and an element written back keeps its namespace', () => {
  const doc = parseXml(
    '<?xml version="1.0"?><!-- a camera --><s:Envelope xmlns:s="urn:s"><s:Body><a:Ref xmlns:a="urn:a"><b:Id xmlns:b="urn:b">7 &amp; 8</b:Id>' +
      '<Note><![CDATA[<raw>]]></Note></a:Ref></s:Body></s:Envelope>',
  );
  const ref = find(doc, 'Ref')!;
  assertEquals([ref.ns, find(ref, 'Id')?.text, find(ref, 'Note')?.text], ['urn:a', '7 & 8', '<raw>']);
  assertEquals(writeXml(find(ref, 'Id')!), '<b:Id xmlns:b="urn:b">7 &amp; 8</b:Id>');
});

Deno.test("a camera's events are motion or a person seen, on or off", () => {
  assertEquals(
    [
      'RuleEngine/CellMotionDetector/Motion',
      'VideoSource/MotionAlarm',
      'RuleEngine/PeopleDetector/People',
      'RuleEngine/MyRuleDetector/HumanDetect',
      'Device/Trigger/DigitalInput',
    ].map(
      eventKind,
    ),
    ['motion', 'motion', 'person', 'person', undefined],
  );
  assertEquals(
    ([{ IsMotion: 'true' }, { State: 'false' }, { Rule: 'MyRule', IsPeople: '1' }, { Region: 'A' }] as Record<string, string>[]).map((data) =>
      eventState({ topic: '', data })
    ),
    [true, false, true, undefined],
  );
});
