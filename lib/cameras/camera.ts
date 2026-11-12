/**
 * What every camera driver does, whatever it asks the camera with: its streams are endpoints of type
 * `stream`, `main` and, when it has a second, smaller one, `sub`, each given to the restreamer as
 * `<device>-<endpoint>`, which keeps one connection to the camera however many watch it. A frame of
 * a stream is the restreamer's JPEG of it, and a page watches it live over the restreamer's
 * WebSocket, which core opens for the page. The restreamer is given the streams it lacks, as after
 * the sidecar started anew, every minute and whenever a frame or a page asks for one it does not
 * have. Every other minute the driver asks for a frame of the camera's smallest stream to know
 * whether it answers; the first frame and the restreamer's probe say what the stream is (its size,
 * codec and sound) where the camera did not. Another service, the media service, reads a stream at
 * the restreamer's RTSP (`source`). Without a restreamer, a frame is the camera's still picture,
 * when it has one, and nothing is watched live.
 *
 * A kind of camera (`rtsp`, `onvif`) says where its streams and still picture are, and may keep
 * endpoints of its own beside them.
 */

import type { DeviceAttrs, DriverConfigField, EndpointAttrs, StreamInfo } from '@ein/api';
import { ADMIN_ACCESS, type Command, type Driver, type ModuleDevices } from '@ein/client';
import { DEV_PATH, devicePath } from '@ein/paths';
import type { Fetch } from '../network/adopt.ts';
import type { NetworkHosts } from '../network/found.ts';
import { jpegSize, type Restreamer } from './restreamer.ts';

/** The endpoints a camera's streams may be, largest first. */
const STREAM_ENDPOINTS = ['main', 'sub'] as const;

const CHECK_EVERY_MS = 60_000;
const SNAPSHOT_TIMEOUT_MS = 10_000;

export type CameraOptions = {
  cmd: Command;
  devices: ModuleDevices;
  /** Unset when no restreamer is set (`CFG_AUTOMATION_STREAMS_URL`). */
  restreamer?: Restreamer;
  fetcher: Fetch;
  /** What the network listener heard, by which a camera found there is followed to a new address. */
  network?: NetworkHosts;
  log(line: string): void;
};

/** One of a camera's streams: its endpoint, and its address with the camera's credentials in it. */
export type CameraStream = { endpoint: (typeof STREAM_ENDPOINTS)[number]; label: string; address: string; info?: StreamInfo };

/** Where a camera's still picture is, and who it is asked as. */
type CameraSnapshot = { url: string; user?: string; password?: string };

/** A kind of camera, as its driver asks it. */
export type CameraKind = {
  name: string;
  description: string;
  config: DriverConfigField[];
  /** The camera's streams, largest first; throws when the camera cannot say. */
  streams(device: string, attrs: DeviceAttrs): Promise<CameraStream[]>;
  /** Its still picture, when it has one. */
  snapshot(device: string, attrs: DeviceAttrs): Promise<CameraSnapshot | undefined>;
  /** Keeps what the camera has beside its streams, each minute and when it is made. */
  keep?(device: string, attrs: DeviceAttrs): Promise<void>;
  write?: Driver['write'];
  forget?(device: string): Promise<void>;
  /** The driver stops: let go of every camera. */
  stop?(): void;
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

export const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Registers `kind`'s driver and keeps its cameras' streams with the restreamer; the answer stops it. */
export const startCameraDriver = (options: CameraOptions, kind: CameraKind): () => void => {
  const { cmd, devices, restreamer, fetcher, log } = options;
  /** When each camera was last asked for a frame. */
  const checked = new Map<string, number>();
  /** Cameras that did not answer last time, so it is said once. */
  const silent = new Set<string>();
  /** Cameras whose streams could not be kept last time, so it is said once. */
  const failing = new Set<string>();
  /** The address each source was given the restreamer with, so one that moved is given again. */
  const given = new Map<string, string>();
  let busy = false;

  const cameras = async () =>
    (await cmd.sys.vfs.children<DeviceAttrs>(ADMIN_ACCESS, DEV_PATH).catch(() => []))
      .filter((child) => child.node.type === 'device' && child.node.attrs.driver === kind.name)
      .map((child) => ({ name: child.name, attrs: child.node.attrs }));

  const attrsOf = async (device: string): Promise<DeviceAttrs | undefined> =>
    (await cmd.sys.vfs.get(ADMIN_ACCESS, devicePath(device)).catch(() => undefined))?.attrs as DeviceAttrs | undefined;

  /** The camera's endpoints, and its streams given to the restreamer where it lacks them or has them at another address. */
  const prepare = async (device: string, attrs: DeviceAttrs, have?: Set<string>): Promise<void> => {
    if (!attrs.class) await devices.ensureDevice(ADMIN_ACCESS, device, { class: 'camera' });
    for (const stream of await kind.streams(device, attrs)) {
      await devices.ensureEndpoint(ADMIN_ACCESS, device, stream.endpoint, 'stream', { label: stream.label, ...stream.info });
      const name = sourceName(device, stream.endpoint);
      if (!restreamer || (have?.has(name) && given.get(name) === stream.address)) continue;
      await restreamer.put(name, stream.address);
      given.set(name, stream.address);
    }
  };

  /** A frame of the camera's smallest stream, which says whether it answers and what size each is. */
  const check = async (device: string, attrs: DeviceAttrs): Promise<void> => {
    checked.set(device, Date.now());
    try {
      const streams = await kind.streams(device, attrs);
      for (const stream of streams.toReversed()) {
        const path = `${devicePath(device)}/${stream.endpoint}`;
        const known = (await cmd.sys.vfs.get(ADMIN_ACCESS, path).catch(() => undefined))?.attrs as EndpointAttrs | undefined;
        if (stream !== streams.at(-1) && known?.width && (!restreamer || known.audio !== undefined)) continue;
        const info: StreamInfo = {};
        const size = jpegSize(await frameOf(device, attrs, stream.endpoint));
        if (size) Object.assign(info, size);
        if (restreamer && known?.audio === undefined) Object.assign(info, await restreamer.probe(sourceName(device, stream.endpoint)));
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
    const snapshot = await kind.snapshot(device, attrs);
    if (!snapshot) throw new Error(`${device} has no still picture to give without a restreamer (CFG_AUTOMATION_STREAMS_URL)`);
    const response = await fetcher(snapshot.url, {
      headers: snapshot.user || snapshot.password ? { authorization: `Basic ${btoa(`${snapshot.user ?? ''}:${snapshot.password ?? ''}`)}` } : {},
      signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`its still picture answered ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };

  /** Every camera's streams given to the restreamer where it lacks them, what else it has kept, and those due checked. */
  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const have = restreamer ? await restreamer.names() : undefined;
      for (const camera of await cameras()) {
        try {
          await prepare(camera.name, camera.attrs, have);
          await kind.keep?.(camera.name, camera.attrs);
          failing.delete(camera.name);
        } catch (error) {
          if (!failing.has(camera.name)) log(`${camera.name}: ${message(error)}`);
          failing.add(camera.name);
        }
        if ((checked.get(camera.name) ?? 0) + 2 * CHECK_EVERY_MS <= Date.now()) await check(camera.name, camera.attrs);
      }
    } catch (error) {
      log(`cameras: ${message(error)}`);
    } finally {
      busy = false;
    }
  };

  const unregister = devices.registerDriver(kind.name, {
    description: kind.description,
    module: 'automation',
    config: kind.config,
    setup: async (device) => {
      const attrs = await attrsOf(device);
      if (!attrs) return;
      // A camera that does not answer yet is made all the same; the check says it is offline.
      await prepare(device, attrs).catch((error) => log(`${device}: ${message(error)}`));
      await kind.keep?.(device, attrs).catch((error) => log(`${device}: ${message(error)}`));
      await check(device, attrs);
    },
    forget: async (device) => {
      checked.delete(device);
      silent.delete(device);
      failing.delete(device);
      await kind.forget?.(device);
      if (!restreamer) return;
      for (const endpoint of STREAM_ENDPOINTS) {
        given.delete(sourceName(device, endpoint));
        await restreamer.remove(sourceName(device, endpoint)).catch(() => {});
      }
    },
    ...(kind.write ? { write: kind.write } : {}),
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
    kind.stop?.();
  };
};
