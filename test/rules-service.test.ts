/**
 * The rules service in a booted EiN with the bridge and a broker of the test's own: a rule a member
 * of the automation group writes runs on a press, read from the devices' messages on the bus, as
 * her and no more than she may; it switches a plug by writing its control; each run is logged; a
 * rule others may change is not run; and automation-rule-check says all that, with the values the
 * rule's conditions read from /dev.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient } from '@ein/testing';
import type { AutomationStatus, RuleCheck } from '@automation/api';
import { shellyButton, shellyPlug } from './fixtures.ts';
import { startStubBroker } from './stub-broker.ts';

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

/** A rule file's YAML, written as JSON, which YAML reads too. */
const ruleText = (rule: unknown) => JSON.stringify(rule).replaceAll("'", "'\\''");

Deno.test({ name: 'automation rules', sanitizeResources: false, sanitizeOps: false }, async (t) => {
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
    await admin.execString('user-create anna && user-passwd anna --new-password hunter2 && user-create bo && user-passwd bo --new-password hunter2');
    await until('the services', () => admin.execJson<AutomationStatus>('automation-status'), (status) => status.connected && status.rules !== undefined);
    await admin.execString('group-add-member automation anna && group-add-member devices anna');
    const signIn = async (username: string) => {
      const client = await testCtx.server.createShellClient({ username, password: 'hunter2' });
      clients.push(client);
      return client;
    };
    const anna = await signIn('anna');
    const bo = await signIn('bo');
    broker.publish(shellyPlug.online.topic, shellyPlug.online.payload, { retain: true });
    broker.publish(shellyPlug.switchStatus.topic, shellyPlug.switchStatus.payload);
    await until('the plug', () => anna.execString('device-show hall-plug'), (text) => text.includes('switch-0-power'));

    await t.step('a member writes a rule; the service reads it', async () => {
      const rule = {
        description: 'The porch button switches the hall plug',
        when: { event: 'porch-button/input-0', is: 'single' },
        if: { state: 'hall-plug/switch-0-power', above: 10 },
        then: ['echo toggle > /dev/hall-plug/switch-0', 'echo fired > /home/anna/fired.txt'],
      };
      await anna.execString(`echo '${ruleText(rule)}' > /etc/automation/rules/porch.yaml && chmod 644 /etc/automation/rules/porch.yaml`);
      await until('loaded', () => admin.execJson<AutomationStatus>('automation-status'), (status) => status.rules?.count === 1);
    });

    await t.step('a press runs it, as its owner, and the plug, which reported on, is switched off', async () => {
      broker.publish(shellyButton.press.topic, shellyButton.press.payload);
      const calls = await until(
        'Switch.Set',
        async () => broker.published.filter((message) => message.topic === 'hall-plug/rpc').map((message) => JSON.parse(message.payload)),
        (calls) => calls.some((call) => call.method === 'Switch.Set'),
      );
      assertEquals(calls.find((call) => call.method === 'Switch.Set').params, { id: 0, on: false });
      const fired = await until('fired.txt', () => admin.execJson<{ props: { uid: number } }>('stat /home/anna/fired.txt'), () => true);
      assertEquals(fired.props.uid, (await admin.execJson<{ uid: number }>('user-info anna')).uid);
    });

    await t.step('a press of another kind does not', async () => {
      const before = broker.published.length;
      broker.publish(shellyButton.longPress.topic, shellyButton.longPress.payload);
      await new Promise((resolve) => setTimeout(resolve, 500));
      assertEquals(broker.published.slice(before).some((message) => message.topic === 'hall-plug/rpc'), false);
    });

    await t.step("a rule's lines can do no more than its owner, and the log says how each run ended", async () => {
      const rule = { when: { event: 'porch-button/input-0', is: 'long' }, then: ['echo x > /home/bo/x.txt', 'echo never > /home/anna/never.txt'] };
      await anna.execString(`echo '${ruleText(rule)}' > /etc/automation/rules/beyond.yaml && chmod 644 /etc/automation/rules/beyond.yaml`);
      await until('loaded', () => admin.execJson<AutomationStatus>('automation-status'), (status) => status.rules?.count === 2);
      broker.publish(shellyButton.longPress.topic, shellyButton.longPress.payload);
      const runs = await until('the run', () => anna.execString('JSON_OUTPUT=0 log-read /var/logs/automation/rules'), (text) => text.includes('beyond'));
      const beyond = runs.trim().split('\n').map((line) => JSON.parse(line.split('\t')[1])).find((run) => run.rule === 'beyond');
      assertEquals(beyond.lines.map((line: { code: number }) => line.code !== 0), [true]);
      assertEquals((await admin.exec('stat /home/anna/never.txt')).success, false);
      assertEquals(runs.includes('"rule":"porch"'), true);
    });

    await t.step('a rule others may change is not run, and says why', async () => {
      await anna.execString(`echo '${ruleText({ when: { every: '1h' }, then: 'true' })}' > /etc/automation/rules/shared.yaml && chmod 664 /etc/automation/rules/shared.yaml`);
      const status = await until('read', () => admin.execJson<AutomationStatus>('automation-status'), (status) => (status.rules?.problems.length ?? 0) > 0);
      assertEquals(status.rules?.problems[0].startsWith('shared: others than its owner'), true);
    });

    await t.step('automation-rule-check says what makes a rule run and whose rights it runs with', async () => {
      const check = await anna.execJson<RuleCheck>('automation-rule-check porch');
      assertEquals([check.owner, check.when, check.then?.length], ['anna', ['porch-button/input-0 is pressed (single)'], 2]);
      assertEquals(check.if, [{ condition: 'hall-plug/switch-0-power above 10', holds: true }]);
      assertEquals((await anna.exec('automation-rule-check shared')).success, false);
    });

    await t.step('only the automation group reads and writes the rules', async () => {
      assertEquals((await bo.exec('ls /etc/automation/rules')).success, false);
      assertEquals((await bo.exec(`echo '{}' > /etc/automation/rules/mine.yaml`)).success, false);
    });
  } finally {
    for (const client of clients) client.close();
    await testCtx.teardown();
    await broker.close();
  }
});
