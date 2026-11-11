import { Alert, Box, Group, SegmentedControl, Stack, Text } from '@mantine/core';
import { EmptyState, PageLoader, TablerIcon } from '@ein/ui/components';
import { useCommand } from '@ein/ui/hooks';
import type { DeviceInfo, EndpointSummary } from '@ein/api';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

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

/** How a stream reaches the page: straight from the restreamer, or through EiN's socket. */
type Via = 'direct' | 'ein';

type Status = { state: 'connecting' | 'playing' | 'ended' | 'failed'; reason?: string; via?: Via };

/** How long WebRTC may take to connect before the stream is played through EiN instead, in ms. */
const DIRECT_WAIT_MS = 5000;

/** Core's `/stream/dev/<device>/<stream>` socket, passed through to the restreamer's. */
const liveSocket = (device: string, stream: string): WebSocket => {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/stream/dev/${encodeURIComponent(device)}/${encodeURIComponent(stream)}`);
  socket.binaryType = 'arraybuffer';
  return socket;
};

type Message = { type: string; value: string };

/**
 * The stream over WebRTC: the offer, the answer and the ICE candidates go through EiN's socket as
 * the restreamer's `webrtc/*` messages, and the picture comes straight from the restreamer's
 * WebRTC port. Without a STUN server the page offers only its own addresses, so it connects where
 * it reaches the restreamer's machine, on the home network. `fallBack` is called when it does not
 * connect within `DIRECT_WAIT_MS`, the restreamer refuses the offer (a codec the browser does not
 * take), or the connection fails later. Returns what stops it.
 */
const playDirect = (element: HTMLVideoElement, device: string, stream: string, onStatus: (status: Status) => void, fallBack: () => void): () => void => {
  const peer = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
  const socket = liveSocket(device, stream);
  let done = false;
  const fail = () => {
    if (done) return;
    stop();
    fallBack();
  };
  const timer = setTimeout(fail, DIRECT_WAIT_MS);
  const stop = () => {
    done = true;
    clearTimeout(timer);
    peer.close();
    socket.close();
  };
  const send = (message: Message) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  peer.addTransceiver('video', { direction: 'recvonly' });
  peer.addTransceiver('audio', { direction: 'recvonly' });
  const media = new MediaStream();
  peer.ontrack = (event) => media.addTrack(event.track);
  peer.onicecandidate = (event) => send({ type: 'webrtc/candidate', value: event.candidate?.candidate ?? '' });
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'failed') return fail();
    if (peer.connectionState !== 'connected' || element.srcObject === media) return;
    clearTimeout(timer);
    element.srcObject = media;
    element.play().then(() => onStatus({ state: 'playing', via: 'direct' })).catch(() => onStatus({ state: 'playing', reason: 'press play', via: 'direct' }));
  };
  socket.onopen = async () => {
    try {
      await peer.setLocalDescription(await peer.createOffer());
      send({ type: 'webrtc/offer', value: peer.localDescription!.sdp });
    } catch {
      fail();
    }
  };
  socket.onmessage = (event) => {
    if (typeof event.data !== 'string') return;
    const message = JSON.parse(event.data) as Message;
    if (message.type === 'webrtc/answer') peer.setRemoteDescription({ type: 'answer', sdp: message.value }).catch(fail);
    else if (message.type === 'webrtc/candidate' && message.value) peer.addIceCandidate({ candidate: message.value, sdpMid: '0' }).catch(() => {});
    else if (message.type === 'error') fail();
  };
  // Once connected the picture no longer needs the socket; before, its end is a failure to connect.
  socket.onclose = () => {
    if (peer.connectionState !== 'connected') fail();
  };
  return stop;
};

/**
 * The stream through EiN: the restreamer sends it as fragmented MP4 for Media Source Extensions
 * over EiN's socket once the page says which codecs it plays. It keeps a few seconds and stays at
 * the newest frame. Returns what stops it.
 */
const playThroughEin = (element: HTMLVideoElement, device: string, stream: string, onStatus: (status: Status) => void): () => void => {
  const Source = mediaSourceClass();
  if (!Source) {
    onStatus({ state: 'failed', reason: 'this browser cannot play a live stream (no Media Source Extensions)' });
    return () => {};
  }
  const source = new Source();
  const url = URL.createObjectURL(source);
  element.src = url;
  let socket: WebSocket | undefined;
  let closed = false;
  source.addEventListener('sourceopen', () => {
    URL.revokeObjectURL(url);
    socket = liveSocket(device, stream);
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
        const message = JSON.parse(event.data) as Message;
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
        element.play().then(() => onStatus({ state: 'playing', via: 'ein' })).catch(() => onStatus({ state: 'playing', reason: 'press play', via: 'ein' }));
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
  };
};

/**
 * A stream played as it comes: over WebRTC straight from the restreamer where the page reaches it,
 * which is under a second behind, and otherwise through EiN, a second or two behind.
 */
function LivePlayer({ device, stream, onStatus }: { device: string; stream: string; onStatus: (status: Status) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [via, setVia] = useState<Via>(() => 'RTCPeerConnection' in globalThis ? 'direct' : 'ein');
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    onStatus({ state: 'connecting' });
    element.disableRemotePlayback = true;
    const stop = via === 'direct' ? playDirect(element, device, stream, onStatus, () => setVia('ein')) : playThroughEin(element, device, stream, onStatus);
    return () => {
      stop();
      element.srcObject = null;
      element.removeAttribute('src');
      element.load();
    };
  }, [device, stream, via, onStatus]);
  return (
    <video
      ref={video}
      muted
      playsInline
      controls
      style={{ width: '100%', maxHeight: 'calc(100dvh - 280px)', background: 'black', borderRadius: 'var(--mantine-radius-sm)' }}
    />
  );
}

/** What the status line says of a stream playing: how it reaches the page. */
const playingLabel = (status: Status): string => status.reason ?? (status.via === 'direct' ? 'Live, direct' : 'Live, through EiN');

/** A stream's name as the choice between them says it: its label, and its size where known. */
const choiceLabel = (endpoint: EndpointSummary): string =>
  endpoint.stream?.width && endpoint.stream.height ? `${endpoint.label} (${endpoint.stream.width}×${endpoint.stream.height})` : endpoint.label;

/**
 * `/camera-live?device=<path>`: a camera's picture live, as the Live tab of its page (a
 * `device.tabs` panel for a device with a stream). The main stream first; a camera with a second,
 * smaller one can be switched to it, which costs less to send.
 */
export default function CameraLivePage() {
  const [params] = useSearchParams();
  const name = (params.get('device') ?? '').split('/').filter(Boolean).at(-1) ?? '';
  const { data: info, loading, error } = useCommand<DeviceInfo>(`device-show ${name}`);
  const streams = (info?.endpointList ?? []).filter((endpoint) => endpoint.type === 'stream' && !endpoint.retired);
  const [chosen, setChosen] = useState<string>();
  const [status, setStatus] = useState<Status>({ state: 'connecting' });
  const stream = streams.find((endpoint) => endpoint.name === chosen) ?? streams[0];

  if (loading && !info) return <PageLoader label='Loading the camera…' />;
  if (error) return <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />}>{error.message}</Alert>;
  if (!stream) return <EmptyState title='No stream'>This device sends no picture.</EmptyState>;
  return (
    <Stack gap='sm' p='md'>
      <Group justify='space-between' wrap='wrap'>
        {streams.length > 1
          ? (
            <SegmentedControl
              size='xs'
              value={stream.name}
              onChange={setChosen}
              data={streams.map((endpoint) => ({ value: endpoint.name, label: choiceLabel(endpoint) }))}
            />
          )
          : <Text size='sm' c='dimmed'>{choiceLabel(stream)}</Text>}
        <Text size='xs' c={status.state === 'failed' ? 'red' : 'dimmed'}>
          {status.state === 'connecting' ? 'Connecting…' : status.state === 'playing' ? playingLabel(status) : status.state === 'ended' ? 'The stream ended' : status.reason}
        </Text>
      </Group>
      <Box>
        <LivePlayer key={stream.name} device={name} stream={stream.name} onStatus={setStatus} />
      </Box>
    </Stack>
  );
}
