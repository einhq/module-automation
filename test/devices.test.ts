/**
 * Devices made by hand, with no broker at all: the automation group makes one with a position,
 * whose track a phone posts to through the link device-tracker gives, and no one else may.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient } from '@ein/testing';
import type { DeviceCreated, DeviceInfo, DeviceTracker } from '@automation/api';

const testCtx = createTestContext({ modules: ['automation'], boot: true });

Deno.test({ name: 'devices made by hand', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { baseUrl } = await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const clients: ShellClient[] = [admin];

  try {
    await admin.execString('user-create anna && user-passwd anna --new-password hunter2 && user-create bo && user-passwd bo --new-password hunter2');
    await admin.execString('group-add-member automation anna');
    const signIn = async (username: string) => {
      const client = await testCtx.server.createShellClient({ username, password: 'hunter2' });
      clients.push(client);
      return client;
    };
    const anna = await signIn('anna');
    const bo = await signIn('bo');

    await t.step("the devices root is the automation group's, with no broker set", async () => {
      // The bridge service makes the group and gives it the root at its start, which a loaded
      // machine reaches after the boot.
      const end = Date.now() + 10_000;
      let seen: [number | undefined, number | undefined] = [undefined, undefined];
      while (Date.now() < end) {
        const group = await admin.exec('group-info automation');
        const automation = group.success ? (group.data as { gid?: number } | undefined)?.gid : undefined;
        seen = [(await admin.execJson<{ props: { gid: number } }>('stat /archive/devices')).props.gid, automation];
        if (automation !== undefined && seen[0] === automation) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assertEquals(seen[0], seen[1]);
    });

    await t.step('a member makes a device with a position, kept as a track', async () => {
      const created = await anna.execJson<DeviceCreated>("device-create Sailboat --model 'Folkbåt' --position");
      assertEquals(created, { device: 'sailboat', path: '/archive/devices/sailboat', track: '/archive/devices/sailboat/position/history' });
      assertEquals((await admin.execJson<{ type: string }>(`stat ${created.track}`)).type, 'track');
      const info = await anna.execJson<DeviceInfo>('device-show sailboat');
      assertEquals([info.label, info.source, info.model], ['Sailboat', 'manual', 'Folkbåt']);
      assertEquals(info.entityList.map((entity) => [entity.name, entity.kind, entity.track?.points]), [['position', 'position', 0]]);
    });

    await t.step('someone outside the group may not', async () => {
      assertEquals((await bo.exec('device-create Rowboat')).success, false);
      assertEquals((await anna.exec('device-create Sailboat')).success, false, 'a name is taken once');
    });

    await t.step('device-tracker gives the link and QR code a phone posts its position to', async () => {
      const off = await anna.execJson<DeviceTracker>('device-tracker sailboat');
      assertEquals(off.enabled, false);
      const on = await anna.execJson<DeviceTracker>('device-tracker sailboat --new --origin https://ein.example');
      assertEquals([on.enabled, on.url?.startsWith('https://ein.example/tracker/'), on.qrSvg?.startsWith('<svg')], [true, true, true]);
      assertEquals(on.qrText, `${on.url}?id=sailboat`);
      const res = await fetch(`${baseUrl}${new URL(on.url!).pathname}?id=sailboat&lat=57.5&lon=11.9&timestamp=1717236000`);
      await res.body?.cancel();
      assertEquals(res.ok, true);
      const info = await anna.execJson<DeviceInfo>('device-show sailboat');
      assertEquals(info.entityList[0].track?.points, 1);
      assertEquals((await anna.execJson<DeviceTracker>('device-tracker sailboat --off')).enabled, false);
    });

    await t.step('a device with no position is given one by device-tracker --new', async () => {
      await anna.execString('device-create Kayak');
      const on = await anna.execJson<DeviceTracker>('device-tracker kayak --new');
      assertEquals([on.track, on.enabled], ['/archive/devices/kayak/position/history', true]);
    });
  } finally {
    for (const client of clients) client.close();
    await testCtx.teardown();
  }
});
