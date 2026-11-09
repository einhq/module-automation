/**
 * Google Cast's own protocol (CastV2), as much as a status and a few commands take: TLS to port
 * 8009, each message a big-endian length and a `CastMessage` protobuf whose payload is JSON in a
 * namespace. A session connects to the receiver (`receiver-0`), asks its status (volume, the app
 * running) and, when an app plays media, connects to that app's transport and asks the media
 * status (player state, title, artist).
 *
 * A Cast device's certificate is its own, signed by no authority, so it is not checked: the
 * connection is to the address the device answered on.
 */

import tls from 'node:tls';

const SENDER = 'sender-ein';
const RECEIVER = 'receiver-0';
const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
};
const TIMEOUT_MS = 8000;

/** What a Cast device says of itself and of what it plays. */
type CastStatus = {
  /** 0 to 1. */
  volume?: number;
  muted?: boolean;
  /** The app running, by its name (`Spotify`, `Backdrop` when idle). */
  app?: string;
  /** `PLAYING`, `PAUSED`, `BUFFERING` or `IDLE`, while an app plays media. */
  player?: string;
  title?: string;
  artist?: string;
};

/** What can be asked of a Cast device. */
type CastCommand =
  | { type: 'volume'; level: number }
  | { type: 'mute'; muted: boolean }
  | { type: 'play' | 'pause' | 'stop' };

// ---- CastMessage ----

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const varint = (value: number): number[] => {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return bytes;
};

const field = (number: number, text: string): number[] => {
  const data = encoder.encode(text);
  return [(number << 3) | 2, ...varint(data.length), ...data];
};

/** One framed CastMessage with a JSON payload. */
export const encodeCastMessage = (destination: string, namespace: string, payload: unknown): Uint8Array => {
  const body = [0x08, 0, ...field(2, SENDER), ...field(3, destination), ...field(4, namespace), 0x28, 0, ...field(6, JSON.stringify(payload))];
  return new Uint8Array([body.length >>> 24, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff, ...body]);
};

type CastMessage = { source: string; namespace: string; payload: Record<string, unknown> };

/** A CastMessage's body (without its length); undefined for one with no JSON payload. */
export const decodeCastMessage = (body: Uint8Array): CastMessage | undefined => {
  const strings: Record<number, string> = {};
  let offset = 0;
  while (offset < body.length) {
    let key = 0, shift = 0, byte;
    do {
      byte = body[offset++];
      key |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    const number = key >> 3;
    if ((key & 7) === 0) {
      while (body[offset++] & 0x80);
    } else if ((key & 7) === 2) {
      let length = 0;
      shift = 0;
      do {
        byte = body[offset++];
        length |= (byte & 0x7f) << shift;
        shift += 7;
      } while (byte & 0x80);
      strings[number] = decoder.decode(body.subarray(offset, offset + length));
      offset += length;
    } else {
      return undefined;
    }
  }
  if (!strings[6]) return undefined;
  try {
    return { source: strings[2] ?? '', namespace: strings[4] ?? '', payload: JSON.parse(strings[6]) };
  } catch {
    return undefined;
  }
};

// ---- a session ----

type Session = {
  send(destination: string, namespace: string, payload: Record<string, unknown>): void;
  /** The next message in `namespace` whose payload `type` is one of `types`. */
  next(namespace: string, types: string[]): Promise<Record<string, unknown>>;
  close(): void;
};

const open = (ip: string): Promise<Session> =>
  new Promise((resolve, reject) => {
    const socket = tls.connect({ host: ip, port: 8009, rejectUnauthorized: false });
    let buffer = new Uint8Array();
    const waiting: { namespace: string; types: string[]; resolve(payload: Record<string, unknown>): void }[] = [];
    let failed: Error | undefined;
    const timer = setTimeout(() => socket.destroy(new Error(`${ip} did not answer in time`)), TIMEOUT_MS);
    const session: Session = {
      send: (destination, namespace, payload) => socket.write(encodeCastMessage(destination, namespace, payload)),
      next: (namespace, types) =>
        failed ? Promise.reject(failed) : new Promise((resolveNext, rejectNext) => {
          waiting.push({ namespace, types, resolve: resolveNext });
          socket.once('close', () => rejectNext(failed ?? new Error(`${ip} closed the connection`)));
        }),
      close: () => {
        clearTimeout(timer);
        socket.destroy();
      },
    };
    socket.on('secureConnect', () => {
      session.send(RECEIVER, NS.connection, { type: 'CONNECT' });
      resolve(session);
    });
    socket.on('error', (error: Error) => {
      failed = error;
      reject(new Error(`cannot reach ${ip}: ${error.message}`));
    });
    socket.on('data', (chunk: Uint8Array) => {
      const joined = new Uint8Array(buffer.length + chunk.length);
      joined.set(buffer);
      joined.set(chunk, buffer.length);
      buffer = joined;
      while (buffer.length >= 4) {
        const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0);
        if (buffer.length < 4 + length) break;
        const message = decodeCastMessage(buffer.subarray(4, 4 + length));
        buffer = buffer.slice(4 + length);
        if (!message) continue;
        if (message.namespace === NS.heartbeat && message.payload.type === 'PING') {
          session.send(message.source, NS.heartbeat, { type: 'PONG' });
          continue;
        }
        const at = waiting.findIndex((each) => each.namespace === message.namespace && each.types.includes(String(message.payload.type)));
        if (at >= 0) waiting.splice(at, 1)[0].resolve(message.payload);
      }
    });
  });

type Application = { appId?: string; displayName?: string; sessionId?: string; transportId?: string; isIdleScreen?: boolean };
type ReceiverStatus = { volume?: { level?: number; muted?: boolean }; applications?: Application[] };
type MediaStatus = { mediaSessionId?: number; playerState?: string; media?: { metadata?: { title?: string; artist?: string; albumArtist?: string } } };

const receiverStatus = async (session: Session): Promise<ReceiverStatus> => {
  session.send(RECEIVER, NS.receiver, { type: 'GET_STATUS', requestId: 1 });
  return ((await session.next(NS.receiver, ['RECEIVER_STATUS'])).status ?? {}) as ReceiverStatus;
};

/** The app that plays media, when one does, its transport connected. */
const mediaApp = (status: ReceiverStatus): Application | undefined => status.applications?.find((app) => !app.isIdleScreen && app.transportId);

const mediaStatus = async (session: Session, app: Application): Promise<MediaStatus | undefined> => {
  session.send(app.transportId!, NS.connection, { type: 'CONNECT' });
  session.send(app.transportId!, NS.media, { type: 'GET_STATUS', requestId: 2 });
  const answer = await session.next(NS.media, ['MEDIA_STATUS']);
  return (answer.status as MediaStatus[] | undefined)?.[0];
};

/** What the Cast device at `ip` plays, and its volume. */
export const castStatus = async (ip: string): Promise<CastStatus> => {
  const session = await open(ip);
  try {
    const receiver = await receiverStatus(session);
    const app = receiver.applications?.[0];
    const status: CastStatus = {
      ...(receiver.volume?.level !== undefined ? { volume: receiver.volume.level } : {}),
      ...(receiver.volume?.muted !== undefined ? { muted: receiver.volume.muted } : {}),
      app: app?.displayName ?? '',
    };
    const playing = mediaApp(receiver);
    const media = playing ? await mediaStatus(session, playing).catch(() => undefined) : undefined;
    status.player = media?.playerState ?? 'IDLE';
    status.title = media?.media?.metadata?.title ?? '';
    status.artist = media?.media?.metadata?.artist ?? media?.media?.metadata?.albumArtist ?? '';
    return status;
  } finally {
    session.close();
  }
};

/** Asks the Cast device at `ip` to do `command`; throws when nothing plays that it could act on. */
export const castCommand = async (ip: string, command: CastCommand): Promise<void> => {
  const session = await open(ip);
  try {
    if (command.type === 'volume' || command.type === 'mute') {
      const volume = command.type === 'volume' ? { level: Math.min(1, Math.max(0, command.level)) } : { muted: command.muted };
      session.send(RECEIVER, NS.receiver, { type: 'SET_VOLUME', volume, requestId: 3 });
      await session.next(NS.receiver, ['RECEIVER_STATUS']);
      return;
    }
    const receiver = await receiverStatus(session);
    const app = mediaApp(receiver);
    if (!app) throw new Error('nothing is playing on it');
    if (command.type === 'stop') {
      session.send(RECEIVER, NS.receiver, { type: 'STOP', sessionId: app.sessionId, requestId: 4 });
      await session.next(NS.receiver, ['RECEIVER_STATUS']);
      return;
    }
    const media = await mediaStatus(session, app);
    if (media?.mediaSessionId === undefined) throw new Error(`${app.displayName ?? 'the app'} plays nothing it can ${command.type}`);
    session.send(app.transportId!, NS.media, { type: command.type.toUpperCase(), mediaSessionId: media.mediaSessionId, requestId: 5 });
    await session.next(NS.media, ['MEDIA_STATUS']);
  } finally {
    session.close();
  }
};
