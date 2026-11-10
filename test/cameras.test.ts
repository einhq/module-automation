/**
 * The rtsp driver in a booted EiN, against a stub of the restreamer's API: a camera made with its
 * stream's address and password is given to the restreamer with the password in the address and
 * nowhere else, its streams say their size and codec, a frame and the live socket come through
 * core, a stream the restreamer lost is given back when it is asked for, and forgetting the camera
 * takes its streams from the restreamer.
 */

import { assert, assertEquals } from '@std/assert';
import type { DeviceInfo } from '@ein/api';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';
import { jpegSize } from '../lib/cameras/restreamer.ts';
import { sourceName, withCredentials } from '../lib/cameras/rtsp.ts';

/** A JPEG's start, a 640×360 frame header and its end: all a frame needs to say its size. */
const FRAME = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0x68, 0x02, 0x80, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);

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

/** go2rtc's API as far as the driver uses it, behind the account `ein` and `password`. */
const stubRestreamer = (password: string) => {
  const sources = new Map<string, string>();
  const live: { src: string | null; authorized: boolean }[] = [];
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, (req) => {
    const url = new URL(req.url);
    const authorized = req.headers.get('authorization') === `Basic ${btoa(`ein:${password}`)}`;
    if (url.pathname === '/api/ws') {
      const { socket, response } = Deno.upgradeWebSocket(req);
      live.push({ src: url.searchParams.get('src'), authorized });
      socket.onmessage = () => socket.send(JSON.stringify({ type: 'mse', value: 'video/mp4; codecs="avc1.640029"' }));
      return response;
    }
    if (!authorized) return new Response('', { status: 401 });
    const src = url.searchParams.get('src') ?? '';
    if (url.pathname === '/api/frame.jpeg') return sources.has(src) ? new Response(FRAME) : new Response('', { status: 404 });
    if (url.pathname !== '/api/streams') return new Response('', { status: 404 });
    if (req.method === 'PUT') sources.set(url.searchParams.get('name') ?? src, src);
    else if (req.method === 'DELETE') sources.delete(src);
    else if (src) {
      return Response.json({
        producers: [{ receivers: [{ codec: { codec_name: 'h264', codec_type: 'video' } }, { codec: { codec_name: 'pcma', codec_type: 'audio' } }] }],
      });
    } else return Response.json(Object.fromEntries([...sources.keys()].map((name) => [name, { producers: [{ url: 'rtsp://***@camera' }] }])));
    return new Response(null);
  });
  return { server, sources, live, url: `http://127.0.0.1:${server.addr.port}` };
};

Deno.test('a camera address takes its user and password, unless it carries its own', () => {
  assertEquals(withCredentials('rtsp://192.0.2.10:554/live', 'viewer', 'p@ss word'), 'rtsp://viewer:p%40ss%20word@192.0.2.10:554/live');
  assertEquals(withCredentials('rtsp://own:one@192.0.2.10/live', 'viewer', 'x'), 'rtsp://own:one@192.0.2.10/live');
  assertEquals(withCredentials('rtsp://192.0.2.10/live'), 'rtsp://192.0.2.10/live');
  assertEquals(jpegSize(FRAME), { width: 640, height: 360 });
  assertEquals(jpegSize(new Uint8Array([1, 2, 3])), undefined);
});

Deno.test({ name: 'rtsp cameras are given to the restreamer and watched through core', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const restreamer = stubRestreamer('streams-secret');
  const testCtx = createTestContext({ modules: ['automation'], boot: true, env: { CFG_AUTOMATION_MQTT_URL: '' } });
  await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  try {
    await admin.execString(
      `config set CFG_AUTOMATION_STREAMS_URL ${restreamer.url} && config set CFG_AUTOMATION_STREAMS_KEY streams-secret && config set CFG_AUTOMATION_STREAMS_RTSP rtsp://192.0.2.1:8554`,
    );
    await admin.execString('service restart automation-bridge');
    await until('the rtsp driver', () => admin.execString('devices --drivers'), (text) => /rtsp/.test(text));

    await t.step('a camera is given to the restreamer with its password in the address, and nowhere else', async () => {
      await admin.execString(
        "device-create 'Front door' --driver rtsp --config url=rtsp://192.0.2.10/main --config sub=rtsp://192.0.2.10/sub --config user=viewer --config password=s3cret",
      );
      assertEquals([...restreamer.sources], [
        [sourceName('front-door', 'main'), 'rtsp://viewer:s3cret@192.0.2.10/main'],
        [sourceName('front-door', 'sub'), 'rtsp://viewer:s3cret@192.0.2.10/sub'],
      ]);
      const info = await admin.execJson<DeviceInfo>('device-show front-door');
      assertEquals([info.class, info.online, info.config?.password], ['camera', true, undefined]);
      assertEquals(info.endpointList.map((endpoint) => [endpoint.name, endpoint.type, endpoint.stream]), [
        ['main', 'stream', { codec: 'h264', width: 640, height: 360, audio: true }],
        ['sub', 'stream', { codec: 'h264', width: 640, height: 360, audio: true }],
      ]);
    });

    await t.step('a frame comes through core, and a stream the restreamer lost is given back for it', async () => {
      restreamer.sources.clear();
      assertEquals((await admin.execString('cat /dev/front-door/sub | wc -c')).trim(), String(FRAME.length));
      assertEquals([...restreamer.sources.keys()], [sourceName('front-door', 'main'), sourceName('front-door', 'sub')]);
    });

    await t.step("the live socket reaches the restreamer's with its account", async () => {
      const { cookie } = await testCtx.harness.createHttpSession();
      const { baseUrl } = testCtx.harness.instance!;
      // Deno's WebSocket takes headers in its options, which its type does not have.
      const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/stream/dev/front-door/main`, { headers: { cookie } } as unknown as string[]);
      const answer = await new Promise<string>((resolve, reject) => {
        socket.onopen = () => socket.send(JSON.stringify({ type: 'mse', value: 'avc1.640029' }));
        socket.onmessage = (event) => resolve(String(event.data));
        socket.onerror = () => reject(new Error('the live socket failed'));
      });
      socket.close();
      assert(answer.includes('"type":"mse"'), answer);
      assertEquals(restreamer.live, [{ src: sourceName('front-door', 'main'), authorized: true }]);
    });

    await t.step("the media service is told the restreamer's RTSP, with its account", async () => {
      assertEquals(
        await testCtx.harness.instance!.devices.streamSource(ADMIN_ACCESS, 'front-door', 'sub'),
        `rtsp://ein:streams-secret@192.0.2.1:8554/${sourceName('front-door', 'sub')}`,
      );
    });

    await t.step('forgetting the camera takes its streams from the restreamer', async () => {
      await admin.execString('device-forget front-door');
      assertEquals(restreamer.sources.size, 0);
    });
  } finally {
    admin.close();
    await testCtx.teardown();
    await restreamer.server.shutdown();
  }
});
