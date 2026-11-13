import { type CSSProperties, useEffect, useRef } from 'react';

/**
 * The codecs a page may be sent, as the restreamer asks (H.264 at three levels, H.265, AAC, FLAC,
 * Opus): the browser says which of them it plays, and the restreamer sends the stream in those.
 */
const CODECS = ['avc1.640029', 'avc1.64002A', 'avc1.640033', 'hvc1.1.6.L153.B0', 'mp4a.40.2', 'mp4a.40.5', 'flac', 'opus'];

/** How far behind the newest frame the picture may fall before it jumps ahead, in seconds. */
const MAX_LAG_S = 2;

/** How much of what has been played is kept, in seconds; the rest is let go. */
const KEEP_S = 15;

type MediaSourceClass = typeof MediaSource;

/** Where a page's media comes from: Safari on an iPhone has only ManagedMediaSource. */
const mediaSourceClass = (): MediaSourceClass | undefined => (globalThis as unknown as { ManagedMediaSource?: MediaSourceClass }).ManagedMediaSource ?? globalThis.MediaSource;

export type LiveStatus = { state: 'connecting' | 'playing' | 'ended' | 'failed'; reason?: string };

/**
 * A stream played as it comes: core's `/stream/dev/<device>/<stream>` socket, passed through to the
 * restreamer, which sends it as fragmented MP4 for Media Source Extensions once the page says which
 * codecs it plays. It keeps a few seconds and stays at the newest frame.
 */
export function LivePlayer({ device, stream, onStatus, controls, style }: {
  device: string;
  stream: string;
  onStatus: (status: LiveStatus) => void;
  /** The browser's own play and full-screen buttons. */
  controls?: boolean;
  style?: CSSProperties;
}) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    const Source = mediaSourceClass();
    if (!element) return;
    if (!Source) {
      onStatus({ state: 'failed', reason: 'this browser cannot play a live stream (no Media Source Extensions)' });
      return;
    }
    onStatus({ state: 'connecting' });
    const source = new Source();
    const url = URL.createObjectURL(source);
    element.disableRemotePlayback = true;
    element.src = url;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket | undefined;
    let closed = false;
    source.addEventListener('sourceopen', () => {
      URL.revokeObjectURL(url);
      socket = new WebSocket(`${protocol}//${location.host}/stream/dev/${encodeURIComponent(device)}/${encodeURIComponent(stream)}`);
      socket.binaryType = 'arraybuffer';
      let buffer: SourceBuffer | undefined;
      const waiting: ArrayBuffer[] = [];
      const append = () => {
        if (!buffer || buffer.updating || waiting.length === 0) return;
        try {
          buffer.appendBuffer(waiting.shift()!);
        } catch {
          // A full buffer: what was played is let go at the next update.
        }
      };
      socket.onopen = () => {
        const plays = CODECS.filter((codec) => Source.isTypeSupported(`video/mp4; codecs="${codec}"`));
        socket?.send(JSON.stringify({ type: 'mse', value: plays.join(',') }));
      };
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') {
          const message = JSON.parse(event.data) as { type: string; value: string };
          if (message.type === 'error') onStatus({ state: 'failed', reason: message.value });
          if (message.type !== 'mse' || buffer) return;
          buffer = source.addSourceBuffer(message.value);
          buffer.mode = 'segments';
          buffer.addEventListener('updateend', () => {
            if (closed || !buffer || buffer.updating) return;
            if (waiting.length) return append();
            const ranges = buffer.buffered;
            if (!ranges.length) return;
            const end = ranges.end(ranges.length - 1);
            if (end - element.currentTime > MAX_LAG_S) element.currentTime = end - 0.3;
            if (element.currentTime - ranges.start(0) > KEEP_S) buffer.remove(ranges.start(0), element.currentTime - KEEP_S);
          });
          element.play().then(() => onStatus({ state: 'playing' })).catch(() => onStatus({ state: 'playing', reason: 'press play' }));
          return;
        }
        waiting.push(event.data as ArrayBuffer);
        append();
      };
      socket.onclose = (event) => {
        if (closed) return;
        onStatus(event.code === 1000 ? { state: 'ended' } : { state: 'failed', reason: event.reason || 'the camera could not be reached' });
      };
    }, { once: true });
    return () => {
      closed = true;
      socket?.close();
      element.removeAttribute('src');
      element.load();
    };
  }, [device, stream, onStatus]);
  return <video ref={video} muted playsInline controls={controls} style={{ background: 'black', ...style }} />;
}
