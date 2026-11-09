/**
 * The bridge in a booted EiN with no broker set: the devices EiN asks over the network itself are
 * read all the same, and the status says no broker is heard.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import type { DeviceInfo, DriverSummary, HealthCheck } from '@ein/api';
import { createTestContext } from '@ein/testing';
import type { AutomationStatus } from '@automation/api';

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

Deno.test({ name: 'without a broker, the devices asked over the network are read', sanitizeResources: false, sanitizeOps: false }, async () => {
  const testCtx = createTestContext({ modules: ['automation'], boot: true, env: { CFG_AUTOMATION_MQTT_URL: '' } });
  await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, () => Response.json({ current: { temperature_2m: 4.5 } }));
  try {
    const status = await until('running', () => admin.execJson<AutomationStatus>('automation-status'), (status) => status.running);
    assertEquals([status.configured, status.connected, status.drivers], [false, false, ['network', 'ipp', 'snmp', 'cast', 'http']]);
    const drivers = await admin.execJson<DriverSummary[]>('devices --drivers');
    assertEquals(drivers.filter((driver) => driver.module === 'automation' && driver.running).map((driver) => driver.name), [
      'cast',
      'http',
      'ipp',
      'network',
      'snmp',
      'virtual',
    ]);

    await admin.execString(`device-create Weather --driver http --config 'url=http://127.0.0.1:${server.addr.port}/' --config 'read=temperature=current.temperature_2m °C'`);
    const info = await until('read', () => admin.execJson<DeviceInfo>('device-show weather'), (info) => info.online === true);
    assertEquals(info.endpointList.map((endpoint) => [endpoint.name, endpoint.last?.value]), [['temperature', 4.5]]);

    const checks = await admin.execJson<HealthCheck[]>('automation-status --checks');
    assertEquals(checks.map((check) => check.state), ['ok']);
    assertStringIncludes(checks[0].reason, '1 devices, 1 endpoints; no broker set');
  } finally {
    await server.shutdown();
    admin.close();
    await testCtx.teardown();
  }
});
