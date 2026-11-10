/**
 * The `rtsp` driver: a camera on the network that sends its picture over RTSP, made by a person with
 * its stream's address (`device-create 'Front door' --driver rtsp --config url=rtsp://… --config
 * password=…`). Its streams are endpoints of type `stream`: `main`, and `sub` when it has a second,
 * smaller one. The password is the device's secret, put into the addresses only here.
 *
 * Each stream is given to the restreamer as `<device>-<endpoint>`, which keeps one connection to the
 * camera however many watch it: a frame of a stream is the restreamer's JPEG of it, and a page
 * watches it live over the restreamer's WebSocket, which core opens for the page. The restreamer is
 * given the streams it lacks, as after the sidecar started anew, every minute and whenever a frame
 * or a page asks for one it does not have. Every other minute the driver asks for a frame of the
 * camera's smallest stream to know whether it answers; the first frame and the restreamer's probe
 * say what the stream is (its size, codec and sound). Another service, the media service, reads a
 * stream at the restreamer's RTSP (`source`). Without a restreamer, a frame is the camera's still picture (`snapshot`), when it has one, and
 * nothing is watched live.
 */

import type { DeviceAttrs, EndpointAttrs, StreamInfo } from '@ein/api';
import { ADMIN_ACCESS, type Command, type ModuleDevices } from '@ein/client';
import { DEV_PATH, devicePath } from '@ein/paths';
import type { Fetch } from '../network/adopt.ts';
import { jpegSize, type Restreamer } from './restreamer.ts';

export const RTSP_DRIVER = 'rtsp';

/** A camera's streams: the config field each address is in, and the endpoint it becomes. */
const STREAMS = [
  { field: 'url', endpoint: 'main', label: 'Main stream' },
  { field: 'sub', endpoint: 'sub', label: 'Smaller stream' },
] as const;

const CHECK_EVERY_MS = 60_000;
const SNAPSHOT_TIMEOUT_MS = 10_000;

type CameraOptions = {
  cmd: Command;
  devices: ModuleDevices;
  /** Unset when no restreamer is set (`CFG_AUTOMATION_STREAMS_URL`). */
  restreamer?: Restreamer;
  fetcher: Fetch;
  log(line: string): void;
};

/** An address with the camera's user and password in it, unless it carries its own. */
export const withCredentials = (address: string, user?: string, password?: string): string => {
  if (!user && !password) return address;
  const url = new URL(address);
  if (url.username || url.password) return address;
  url.username = encodeURIComponent(user ?? '');
  url.password = encodeURIComponent(password ?? '');
  return url.toString();
};

/** The restreamer's name for one of a device's streams. */
export const sourceName = (device: string, endpoint: string): string => `${device}-${endpoint}`;

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Registers the `rtsp` driver and keeps its cameras' streams with the restreamer; the answer stops it. */
export const startCameras = (options: CameraOptions): () => void => {
  const { cmd, devices, restreamer, fetcher, log } = options;
  /** When each camera was last asked for a frame. */
  const checked = new Map<string, number>();
  /** Cameras that did not answer last time, so it is said once. */
  const silent = new Set<string>();
  let busy = false;

  const cameras = async () =>
    (await cmd.sys.vfs.children<DeviceAttrs>(ADMIN_ACCESS, DEV_PATH).catch(() => []))
      .filter((child) => child.node.type === 'device' && child.node.attrs.driver === RTSP_DRIVER)
      .map((child) => ({ name: child.name, attrs: child.node.attrs }));

  const attrsOf = async (device: string): Promise<DeviceAttrs | undefined> =>
    (await cmd.sys.vfs.get(ADMIN_ACCESS, devicePath(device)).catch(() => undefined))?.attrs as DeviceAttrs | undefined;

  /** Each of a camera's streams, with its address as the camera is reached at it. */
  const streamsOf = async (device: string, attrs: DeviceAttrs) => {
    const config = attrs.config ?? {};
    const secret = await devices.secret(ADMIN_ACCESS, device);
    return STREAMS.filter((stream) => config[stream.field]).map((stream) => ({
      ...stream,
      address: withCredentials(config[stream.field], config.user, secret.password),
    }));
  };

  /** The camera's endpoints, and its streams given to the restreamer where it lacks them. */
  const prepare = async (device: string, attrs: DeviceAttrs, have?: Set<string>): Promise<void> => {
    if (!attrs.class) await devices.ensureDevice(ADMIN_ACCESS, device, { class: 'camera' });
    for (const stream of await streamsOf(device, attrs)) {
      await devices.ensureEndpoint(ADMIN_ACCESS, device, stream.endpoint, 'stream', { label: stream.label });
      const name = sourceName(device, stream.endpoint);
      if (restreamer && !have?.has(name)) await restreamer.put(name, stream.address);
    }
  };

  /** A frame of the camera's smallest stream, which says whether it answers and what size each is. */
  const check = async (device: string, attrs: DeviceAttrs): Promise<void> => {
    checked.set(device, Date.now());
    const streams = await streamsOf(device, attrs);
    try {
      for (const stream of streams.toReversed()) {
        const path = `${devicePath(device)}/${stream.endpoint}`;
        const known = (await cmd.sys.vfs.get(ADMIN_ACCESS, path).catch(() => undefined))?.attrs as EndpointAttrs | undefined;
        if (stream !== streams.at(-1) && known?.width) continue;
        const info: StreamInfo = {};
        const size = jpegSize(await frameOf(device, attrs, stream.endpoint));
        if (size) Object.assign(info, size);
        if (restreamer && !known?.codec) Object.assign(info, await restreamer.probe(sourceName(device, stream.endpoint)));
        await devices.ensureEndpoint(ADMIN_ACCESS, device, stream.endpoint, 'stream', info);
      }
      await devices.online(ADMIN_ACCESS, device, true);
      silent.delete(device);
    } catch (error) {
      if (!silent.has(device)) log(`${device}: ${message(error)}`);
      silent.add(device);
      await devices.online(ADMIN_ACCESS, device, false);
    }
  };

  /** The camera's streams given to the restreamer when it lacks `endpoint`'s; answers whether it did. */
  const restate = async (device: string, attrs: DeviceAttrs, endpoint: string): Promise<boolean> => {
    const have = await restreamer!.names();
    if (have.has(sourceName(device, endpoint))) return false;
    await prepare(device, attrs, have);
    return true;
  };

  const frameOf = async (device: string, attrs: DeviceAttrs, endpoint: string): Promise<Uint8Array<ArrayBuffer>> => {
    if (restreamer) {
      try {
        return await restreamer.frame(sourceName(device, endpoint));
      } catch (error) {
        if (!await restate(device, attrs, endpoint)) throw error;
        return await restreamer.frame(sourceName(device, endpoint));
      }
    }
    const snapshot = attrs.config?.snapshot;
    if (!snapshot) throw new Error(`${device} has no still picture to give without a restreamer (CFG_AUTOMATION_STREAMS_URL)`);
    const secret = await devices.secret(ADMIN_ACCESS, device);
    const user = attrs.config?.user ?? '';
    const response = await fetcher(snapshot, {
      headers: secret.password || user ? { authorization: `Basic ${btoa(`${user}:${secret.password ?? ''}`)}` } : {},
      signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`its still picture answered ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };

  /** Every camera's streams given to the restreamer where it lacks them, and those due checked. */
  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const have = restreamer ? await restreamer.names() : undefined;
      for (const camera of await cameras()) {
        await prepare(camera.name, camera.attrs, have).catch((error) => log(`${camera.name}: ${message(error)}`));
        if ((checked.get(camera.name) ?? 0) + 2 * CHECK_EVERY_MS <= Date.now()) await check(camera.name, camera.attrs);
      }
    } catch (error) {
      log(`cameras: ${message(error)}`);
    } finally {
      busy = false;
    }
  };

  const unregister = devices.registerDriver(RTSP_DRIVER, {
    description: 'A camera that sends its picture over RTSP: its streams, to watch live and take a picture of',
    module: 'automation',
    config: [
      { name: 'url', label: 'Stream address, rtsp://camera/…', type: 'url', required: true },
      { name: 'sub', label: 'Address of a second, smaller stream', type: 'url' },
      { name: 'snapshot', label: 'Address of a still picture, http://camera/…', type: 'url' },
      { name: 'user', label: 'User', type: 'string' },
      { name: 'password', label: 'Password', type: 'string', secret: true },
    ],
    setup: async (device) => {
      const attrs = await attrsOf(device);
      if (!attrs) return;
      await prepare(device, attrs);
      await check(device, attrs);
    },
    forget: async (device) => {
      checked.delete(device);
      silent.delete(device);
      if (!restreamer) return;
      for (const stream of STREAMS) await restreamer.remove(sourceName(device, stream.endpoint)).catch(() => {});
    },
    frame: async ({ device, endpoint, attrs }) => ({ bytes: await frameOf(device, attrs, endpoint), type: 'image/jpeg' }),
    source: async ({ device, endpoint, attrs }) => {
      if (!restreamer) throw new Error('no restreamer is set (CFG_AUTOMATION_STREAMS_URL), so no other service reads a stream');
      await restate(device, attrs, endpoint);
      return restreamer.rtsp(sourceName(device, endpoint));
    },
    live: async ({ device, endpoint, attrs }) => {
      if (!restreamer) throw new Error('no restreamer is set (CFG_AUTOMATION_STREAMS_URL), so nothing is watched live');
      await restate(device, attrs, endpoint);
      return restreamer.live(sourceName(device, endpoint));
    },
  });

  const timer = setInterval(() => tick().catch(() => {}), CHECK_EVERY_MS);
  tick().catch(() => {});
  return () => {
    clearInterval(timer);
    unregister();
  };
};
