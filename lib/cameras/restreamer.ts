/**
 * The restreamer cameras are given to: go2rtc's HTTP API, in the automation sidecar
 * (`CFG_AUTOMATION_STREAMS_URL`, as the account `ein` with `CFG_AUTOMATION_STREAMS_KEY`). It keeps
 * one connection to each source it is given and serves it again: a JPEG of it now, MSE over a
 * WebSocket to a page, and RTSP to the media service, at `CFG_AUTOMATION_STREAMS_RTSP` as the media
 * service reaches it, as `ein` too. A source is named `<device>-<endpoint>`, and its address, with
 * the camera's password in it, never leaves the driver and the restreamer: go2rtc shows it masked.
 */

import type { StreamInfo } from '@ein/api';
import type { Fetch } from '../network/adopt.ts';

/** What the restreamer says of a source when it is asked to connect to it. */
type Probed = {
  producers?: { receivers?: { codec?: { codec_name?: string; codec_type?: string } }[] }[];
};

export type Restreamer = {
  /** The names of the sources it has now. */
  names(): Promise<Set<string>>;
  /** Gives it `source` as `name`, in place of what it had under that name. */
  put(name: string, source: string): Promise<void>;
  remove(name: string): Promise<void>;
  /** A JPEG of the source now; throws when the camera does not give one. */
  frame(name: string): Promise<Uint8Array<ArrayBuffer>>;
  /** What the source sends: its video's codec and whether it has sound. */
  probe(name: string): Promise<StreamInfo>;
  /** Where a page watches it live: go2rtc's WebSocket, with the account's credentials. */
  live(name: string): { url: string; headers: Record<string, string> };
  /** Where the media service reads it: go2rtc's RTSP, with the account's credentials. */
  rtsp(name: string): string;
};

const TIMEOUT_MS = 12_000;

export const createRestreamer = (fetcher: Fetch, base: string, password: string, rtspBase = ''): Restreamer => {
  const root = base.replace(/\/+$/, '');
  const headers = { authorization: `Basic ${btoa(`ein:${password}`)}` };
  const ask = async (method: string, path: string, query: Record<string, string>): Promise<Response> => {
    const response = await fetcher(`${root}${path}?${new URLSearchParams(query)}`, { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) {
      const text = (await response.text()).trim();
      throw new Error(`the restreamer answered ${response.status}${text ? `: ${text}` : ''}`);
    }
    return response;
  };
  return {
    names: async () => new Set(Object.keys(await (await ask('GET', '/api/streams', {})).json() ?? {})),
    put: async (name, source) => void await (await ask('PUT', '/api/streams', { name, src: source })).body?.cancel(),
    remove: async (name) => void await (await ask('DELETE', '/api/streams', { src: name })).body?.cancel(),
    frame: async (name) => new Uint8Array(await (await ask('GET', '/api/frame.jpeg', { src: name })).arrayBuffer()),
    probe: async (name) => {
      const probed = await (await ask('GET', '/api/streams', { src: name, video: 'all', audio: 'all' })).json() as Probed;
      const codecs = (probed.producers ?? []).flatMap((producer) => producer.receivers ?? []).map((receiver) => receiver.codec ?? {});
      const video = codecs.find((codec) => codec.codec_type === 'video')?.codec_name;
      return { ...(video ? { codec: video } : {}), audio: codecs.some((codec) => codec.codec_type === 'audio') };
    },
    live: (name) => ({ url: `${root.replace(/^http/, 'ws')}/api/ws?${new URLSearchParams({ src: name })}`, headers }),
    rtsp: (name) => {
      if (!rtspBase) throw new Error('CFG_AUTOMATION_STREAMS_RTSP is not set, so no other service is told where a stream is');
      const url = new URL(`${rtspBase.replace(/\/+$/, '')}/${encodeURIComponent(name)}`);
      url.username = 'ein';
      url.password = encodeURIComponent(password);
      return url.toString();
    },
  };
};

/** A JPEG's width and height, from its first frame header; undefined for bytes that are not one. */
export const jpegSize = (bytes: Uint8Array): { width: number; height: number } | undefined => {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  for (let at = 2; at + 9 < bytes.length;) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1];
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    // SOF0 to SOF15, but for DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[at + 5] << 8) | bytes[at + 6], width: (bytes[at + 7] << 8) | bytes[at + 8] };
    }
    at += 2 + length;
  }
  return undefined;
};
