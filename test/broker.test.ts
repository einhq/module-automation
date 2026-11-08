/**
 * The bridge's connection against a real broker, when AUTOMATION_TEST_MQTT_URL names one
 * (`make -C ~/m/git/ein/wow/main mqtt`): a retained message comes back marked retained, filters
 * match, a cleared retained message is gone, and losing the broker resolves `closed`.
 */

import { assertEquals } from '@std/assert';
import { connectMqtt, type MqttMessage } from '../lib/mqtt.ts';

const url = Deno.env.get('AUTOMATION_TEST_MQTT_URL');

const until = async (what: string, check: () => boolean, timeoutMs = 5000): Promise<void> => {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

Deno.test({ name: 'a real broker', ignore: !url, sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const run = crypto.randomUUID().slice(0, 8);
  const topic = `ein-test-${run}/sensor/temperature`;
  const device = await connectMqtt({ url: url!, clientId: `ein-test-device-${run}` })(() => {});
  const heard: MqttMessage[] = [];
  const bridge = await connectMqtt({ url: url!, clientId: `ein-test-bridge-${run}` })((message) => heard.push(message));

  try {
    await t.step('a retained message is replayed to a new subscriber, marked retained', async () => {
      await device.publish(topic, '21.4', { retain: true });
      await bridge.subscribe([`ein-test-${run}/+/+`]);
      await until('retained', () => heard.some((message) => message.topic === topic && message.retained));
      assertEquals(heard.find((message) => message.topic === topic)?.payload, '21.4');
    });

    await t.step('a live message is not marked retained', async () => {
      await device.publish(topic, '21.5');
      await until('live', () => heard.some((message) => message.payload === '21.5'));
      assertEquals(heard.find((message) => message.payload === '21.5')?.retained, false);
    });

    await t.step('an empty retained message clears it', async () => {
      await device.publish(topic, '', { retain: true });
      await until('cleared', () => heard.some((message) => message.payload === ''));
      const late: MqttMessage[] = [];
      const another = await connectMqtt({ url: url!, clientId: `ein-test-late-${run}` })((message) => late.push(message));
      await another.subscribe([topic]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assertEquals(late, []);
      await another.close();
    });

    await t.step('closing resolves closed', async () => {
      await bridge.close();
      await bridge.closed;
    });
  } finally {
    await device.close();
    await bridge.close();
  }
});
