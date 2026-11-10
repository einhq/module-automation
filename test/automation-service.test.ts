/**
 * The automation engine in a booted EiN with the bridge and a broker of the test's own: an
 * automation a member of the automation group writes runs on a press, as her and no more than she
 * may; it switches a plug by writing its control and runs a line with the value it was sent, never
 * as part of the line; an automation whose owner may not read what it reads, or that others may
 * change, is held back and says why; a timer runs on over a restart of the service and a move of
 * its node; a module's automation runs and only the administrator turns it off; and the commands
 * say all that.
 */

import { assert, assertEquals } from '@std/assert';
import { createTestContext, type ShellClient } from '@ein/testing';
import type { AutomationCheck, AutomationDetail, AutomationRunStatus, AutomationSetAnswer, AutomationStatus, AutomationSummary } from '@automation/api';
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

/** A shell word holding `text`, single-quoted. */
const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

const PORCH = `description: The porch button toggles the hall plug and notes the press
nodes:
  press: {type: device, endpoint: porch-button/input-0, is: single, to: [toggle, note]}
  toggle: {type: control, endpoint: hall-plug/switch-0, value: toggle}
  note: {type: shell, run: 'echo "$VALUE" > /home/anna/fired.txt'}
`;

const TIMER = (x: number) =>
  `nodes:
  go: {type: button, to: [linger], pos: [${x}, 0]}
  linger: {type: timer, off-after: 3s, to: {false: [done]}}
  done: {type: shell, run: 'echo done > /home/anna/timer.txt'}
`;

const NASTY = `nodes:
  go: {type: button, to: [word]}
  word: {type: set, value: "a'; echo pwned > /home/anna/pwned.txt; echo '", to: [note]}
  note: {type: shell, run: 'echo "$VALUE" > /home/anna/value.txt'}
`;

Deno.test({ name: 'automation engine', sanitizeResources: false, sanitizeOps: false }, async (t) => {
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
    for (const name of ['anna', 'bo', 'carl']) await admin.execString(`user-create ${name} && user-passwd ${name} --new-password hunter2`);
    await until('the services', () => admin.execJson<AutomationStatus>('automation-status'), (status) => status.connected && status.automations !== undefined);
    await admin.execString('group-add-member automation anna && group-add-member devices anna && group-add-member automation bo');
    const signIn = async (username: string) => {
      const client = await testCtx.server.createShellClient({ username, password: 'hunter2' });
      clients.push(client);
      return client;
    };
    const anna = await signIn('anna');
    const bo = await signIn('bo');
    const carl = await signIn('carl');
    broker.publish(shellyPlug.online.topic, shellyPlug.online.payload, { retain: true });
    broker.publish(shellyPlug.switchStatus.topic, shellyPlug.switchStatus.payload);
    broker.publish(shellyButton.longPress.topic, shellyButton.longPress.payload);
    await until('the plug', () => anna.execString('device-show hall-plug'), (text) => text.includes('switch-0-power'));
    await until('the button', () => anna.execString('device-show porch-button'), (text) => text.includes('input-0'));
    const running = (name: string) =>
      until(`${name} running`, () => admin.execJson<AutomationSummary[]>('automations'), (list) => list.some((each) => each.name === name && each.running));

    await t.step('a member makes one from a starting point, a db-tier file only she may change', async () => {
      const made = await anna.execJson<AutomationSetAnswer>('automation-new porch --from button-toggle');
      assertEquals([made.created, made.path], [true, '/etc/automations/porch.yaml']);
      const stat = await admin.execJson<{ props: { uid: number; mode: number; tier?: string } }>('stat /etc/automations/porch.yaml');
      assertEquals([stat.props.mode & 0o777, stat.props.tier], [0o644, 'db']);
      assertEquals((await anna.exec('automation-new porch')).success, false);
    });

    await t.step('one with problems is refused, unless as a draft, and says where they are', async () => {
      const refused = await anna.exec(`automation-set porch --yaml ${quoted('nodes: {a: {type: delay}}')}`);
      assertEquals(refused.success, false);
      const draft = await anna.execJson<AutomationSetAnswer>(`automation-set porch --draft --yaml ${quoted('nodes: {a: {type: delay}}')}`);
      assertEquals([draft.written, draft.problems], [true, [{ node: 'a', message: 'for is needed: for' }]]);
      const broken = await anna.exec(`automation-set porch --draft --yaml ${quoted('nodes: {a: [')}`);
      assertEquals([broken.success, (await anna.execString('cat /etc/automations/porch.yaml')).includes('delay')], [false, true]);
      const listed = await until(
        'held back',
        () => anna.execJson<AutomationSummary[]>('automations'),
        (list) => list.some((each) => each.name === 'porch' && each.problems.length > 0),
      );
      assertEquals(listed.find((each) => each.name === 'porch')?.running, false);
    });

    await t.step('a press runs it as its owner: the plug, which reported on, is switched off, and the line gets the value', async () => {
      await anna.execString(`automation-set porch --yaml ${quoted(PORCH)}`);
      await running('porch');
      broker.publish(shellyButton.press.topic, shellyButton.press.payload);
      const calls = await until(
        'Switch.Set',
        async () => broker.published.filter((message) => message.topic === 'hall-plug/rpc').map((message) => JSON.parse(message.payload)),
        (calls) => calls.some((call) => call.method === 'Switch.Set'),
      );
      assertEquals(calls.find((call) => call.method === 'Switch.Set').params, { id: 0, on: false });
      const fired = await until('fired.txt', () => admin.execString('cat /home/anna/fired.txt'), (text) => text.trim() === 'single');
      assertEquals(fired.trim(), 'single');
      const stat = await admin.execJson<{ props: { uid: number } }>('stat /home/anna/fired.txt');
      assertEquals(stat.props.uid, (await admin.execJson<{ uid: number }>('user-info anna')).uid);
      const status = await anna.execJson<AutomationRunStatus>('automation-status porch');
      assertEquals([status.running, status.nodes.press.value], [true, 'single']);
    });

    await t.step('a press of another kind does not', async () => {
      const before = broker.published.length;
      broker.publish(shellyButton.longPress.topic, shellyButton.longPress.payload);
      await new Promise((resolve) => setTimeout(resolve, 500));
      assertEquals(broker.published.slice(before).some((message) => message.topic === 'hall-plug/rpc'), false);
    });

    await t.step('a value reaches a line as $VALUE, never as part of it', async () => {
      await anna.execString(`automation-set nasty --yaml ${quoted(NASTY)}`);
      await running('nasty');
      await anna.execString('automation-trigger nasty go');
      const value = await until('value.txt', () => admin.execString('cat /home/anna/value.txt'), (text) => text.includes('pwned'));
      assertEquals(value.trim(), "a'; echo pwned > /home/anna/pwned.txt; echo '");
      assertEquals((await admin.exec('stat /home/anna/pwned.txt')).success, false);
      const log = await until('the run log', () => anna.execString('JSON_OUTPUT=0 log-read /var/logs/automations/nasty'), (text) => text.includes('"action"'));
      assert(log.includes('"node":"note"'));
      assertEquals((await bo.exec('log-read /var/logs/automations/nasty')).success, false, "the run log is its owner's");
    });

    await t.step('a timer runs on over a restart of the service and a move of its node', async () => {
      await anna.execString(`automation-set timer --yaml ${quoted(TIMER(0))}`);
      await running('timer');
      await anna.execString('automation-trigger timer go');
      await anna.execString(`automation-set timer --yaml ${quoted(TIMER(300))}`);
      await admin.execString('service restart automation-engine');
      await until('timer.txt', () => admin.execString('cat /home/anna/timer.txt'), (text) => text.trim() === 'done', 15_000);
    });

    await t.step('one whose owner may not read what it reads is held back, saying why, and runs once she may', async () => {
      const mode = (await admin.execJson<{ props: { mode: number } }>('stat /dev/porch-button/input-0')).props.mode & 0o777;
      await admin.execString('chmod 600 /dev/porch-button/input-0');
      await bo.execString(`automation-set bos --yaml ${quoted('nodes: {press: {type: device, endpoint: porch-button/input-0}}')}`);
      const list = await until(
        'held back',
        () => bo.execJson<AutomationSummary[]>('automations'),
        (list) => (list.find((each) => each.name === 'bos')?.problems.length ?? 0) > 0,
      );
      const bos = list.find((each) => each.name === 'bos')!;
      assertEquals([bos.running, bos.problems[0].message], [false, 'its owner may not read porch-button/input-0, or there is no such endpoint']);
      assertEquals((await bo.exec('automation-status porch')).success, false, "another's nodes are not bo's to see");
      await anna.execString('automation-enable porch');
      const lost = await anna.execJson<AutomationSummary[]>('automations');
      assertEquals(lost.find((each) => each.name === 'porch')?.running, false, 'anna lost the press too, and the check again says so');
      await admin.execString(`chmod ${mode.toString(8)} /dev/porch-button/input-0`);
      await anna.execString('automation-enable porch');
      await running('porch');
    });

    await t.step('one others may change, by its mode or its access list, is not run', async () => {
      await anna.execString(`automation-set shared --yaml ${quoted('nodes: {go: {type: button}}')} && chmod 664 /etc/automations/shared.yaml`);
      await anna.execString(`automation-set listed --yaml ${quoted('nodes: {go: {type: button}}')} && share-set /etc/automations/listed.yaml -m u:bo:rw`);
      const list = await until(
        'held back',
        () => anna.execJson<AutomationSummary[]>('automations'),
        (list) => ['shared', 'listed'].every((name) => (list.find((each) => each.name === name)?.problems.length ?? 0) > 0),
      );
      for (const name of ['shared', 'listed']) assert(list.find((each) => each.name === name)!.problems[0].message.startsWith('others than its owner may change it'));
    });

    await t.step('automation-check says what each node would say now, as the caller reads it', async () => {
      const check = await anna.execJson<AutomationCheck>('automation-check porch');
      assertEquals(check.problems, []);
      assertEquals(check.endpoints.find((each) => each.endpoint === 'hall-plug/switch-0')?.readable, true);
      const show = await anna.execJson<AutomationDetail>('automation-show porch');
      assertEquals([show.owner, show.writable, Object.keys(show.spec?.nodes ?? {})], ['anna', true, ['press', 'toggle', 'note']]);
      assert(show.spec!.nodes.press.pos, 'a node without a place is given one');
    });

    await t.step("a module's automation runs as the administrator, and only the administrator turns it off", async () => {
      await admin.execString(
        `mkdir -p /etc/automations.d/stub && echo ${quoted(TIMER(0).replace('/home/anna/timer.txt', '/home/anna/module.txt'))} > /etc/automations.d/stub/hello.yaml`,
      );
      await running('stub/hello');
      assertEquals((await anna.exec('automation-disable stub/hello')).success, false);
      await admin.execString('automation-disable stub/hello');
      const list = await anna.execJson<AutomationSummary[]>('automations');
      assertEquals(list.find((each) => each.name === 'stub/hello')?.enabled, false);
      await admin.execString('automation-enable stub/hello');
      await running('stub/hello');
    });

    await t.step('a person turns her own off and on', async () => {
      await anna.execString('automation-disable porch');
      const off = await anna.execJson<AutomationSummary[]>('automations');
      assertEquals(off.find((each) => each.name === 'porch')?.enabled, false);
      assertEquals((await bo.exec('automation-enable porch')).success, false);
      await anna.execString('automation-enable porch');
      await running('porch');
    });

    await t.step('a virtual device averages two sensors, and follows them', async () => {
      await admin.execString('device-create hall-sensor --driver webhook && device-create kitchen-sensor --driver webhook');
      await admin.execString(`echo '{"temperature": 20}' > /dev/hall-sensor && echo '{"temperature": 23}' > /dev/kitchen-sensor`);
      await anna.execString(
        `device-create indoors --driver virtual --class sensor --config ${
          quoted('read=temperature=avg hall-sensor/temperature kitchen-sensor/temperature; warmest=max hall-sensor/temperature kitchen-sensor/temperature')
        } --config ${quoted('set=away=bool; setpoint=number 5..30 0.5 °C')}`,
      );
      const reading = (endpoint: string) => async () => (await anna.execString(`tail -n 1 /dev/indoors/${endpoint}`)).trim();
      await until('the average', reading('temperature'), (text) => text.includes('21.5'));
      await admin.execString(`echo '{"temperature": 26}' > /dev/kitchen-sensor`);
      await until('the average again', reading('temperature'), (text) => text.includes('23'));
      await until('the warmest', reading('warmest'), (text) => text.includes('26'));
      assertEquals((await anna.exec('echo 99 > /dev/indoors/temperature')).success, false, "a worked-out reading is no member's to write");
    });

    await t.step("a virtual device's control holds what is set, and an automation hears it", async () => {
      await anna.execString('echo on > /dev/indoors/away');
      await until('away', async () => (await anna.execString('tail -n 1 /dev/indoors/away')).trim(), (text) => text.includes('true'));
      await anna.execString('echo toggle > /dev/indoors/away');
      await until('back', async () => (await anna.execString('tail -n 1 /dev/indoors/away')).trim(), (text) => text.includes('false'));
      assertEquals((await anna.exec('echo 40 > /dev/indoors/setpoint')).success, false, 'a setpoint keeps to its range');
      await anna.execString(
        `automation-set away --yaml ${
          quoted('nodes: {away: {type: device, endpoint: indoors/away, to: [note]}, note: {type: shell, run: \'echo "$VALUE" > /home/anna/away.txt\'}}')
        }`,
      );
      await running('away');
      await anna.execString('echo on > /dev/indoors/away');
      await until('away.txt', () => admin.execString('cat /home/anna/away.txt'), (text) => text.trim() === 'on');
    });

    await t.step('a virtual device may not read what the devices group may not, nor itself', async () => {
      await admin.execString('chmod 600 /dev/hall-sensor/temperature');
      assertEquals((await anna.exec(`device-create narrowed --driver virtual --config ${quoted('read=t=avg hall-sensor/temperature')}`)).success, false);
      assertEquals((await anna.exec(`device-create loop --driver virtual --config ${quoted('read=t=last loop/t')}`)).success, false);
    });

    await t.step('only the automation group reads and writes automations', async () => {
      assertEquals((await carl.exec('ls /etc/automations')).success, false);
      assertEquals((await carl.exec('automation-new mine')).success, false);
    });
  } finally {
    for (const client of clients) client.close();
    await testCtx.teardown();
    await broker.close();
  }
});
