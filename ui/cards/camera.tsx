import { Box, Skeleton, Stack, Text } from '@mantine/core';
import { useDocumentVisibility } from '@mantine/hooks';
import type { DeviceInfo } from '@ein/api';
import { TablerIcon } from '@ein/ui/components';
import { usePolledCommand } from '@ein/ui/hooks';
import { formatTime, shq } from '@ein/ui/lib';
import { type CSSProperties, type ReactNode, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LivePlayer, type LiveStatus } from '../cameras/LivePlayer.tsx';

/** How long a tap plays the camera live before the card goes back to its pictures. */
const TAPPED_LIVE_MS = 5 * 60_000;

/** How long after a live stream failed or ended it is tried again. */
const RETRY_LIVE_MS = 60_000;

/** The URL of a frame of `device`'s `stream` now; `at` makes each one new. */
const frameUrl = (device: string, stream: string, at: number): string => `/file/dev/${encodeURIComponent(device)}/${encodeURIComponent(stream)}?at=${at}`;

/** A frame loaded: its URL and when it was asked for. */
type Frame = { url: string; at: number };

/**
 * A frame of the stream every `everyMs` while the page is seen, each loaded before it is shown so
 * the picture never blanks between two; the last one stays when a new one fails, and `failed`
 * says so.
 */
function useFrames(device: string, stream: string | undefined, everyMs: number, enabled: boolean): { frame?: Frame; failed: boolean } {
  const visible = useDocumentVisibility() === 'visible';
  const [frame, setFrame] = useState<Frame>();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFrame(undefined), [device, stream]);
  useEffect(() => {
    if (!stream || !enabled || !visible) return;
    let live = true;
    const load = () => {
      const at = Date.now();
      const url = frameUrl(device, stream, at);
      const image = new Image();
      image.onload = () => {
        if (!live) return;
        setFrame({ url, at });
        setFailed(false);
      };
      image.onerror = () => live && setFailed(true);
      image.src = url;
    };
    load();
    const timer = setInterval(load, everyMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [device, stream, everyMs, enabled, visible]);
  return { frame, failed };
}

/** What a tile says in place of its picture, in the middle. */
function Quiet({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <Stack h='100%' align='center' justify='center' gap={6} p='md' ta='center' style={{ color: 'var(--mantine-color-dimmed)' }}>
      <TablerIcon name={icon} size={28} stroke={1.5} />
      <Text size='sm' c='dimmed' maw={260}>{children}</Text>
    </Stack>
  );
}

/**
 * `/cards/automation/camera`: a camera's picture filling the tile — a new one every `every`
 * seconds (10 unless set), or live when `live` is set — from its `stream`, its first unless named,
 * with its name and when the picture is from over its foot. A tap plays it live for five minutes,
 * or goes back to pictures; while a stream cannot be played live the card shows pictures, saying
 * why, and tries again each minute.
 * `fit=contain` shows the whole picture where it does not fill the tile.
 */
export default function CameraCard() {
  const [params] = useSearchParams();
  const device = params.get('device') ?? '';
  const everyMs = Math.max(2, Number(params.get('every')) || 10) * 1000;
  const alwaysLive = params.get('live') === 'true';
  const fit: CSSProperties['objectFit'] = params.get('fit') === 'contain' ? 'contain' : 'cover';
  const info = usePolledCommand<DeviceInfo>(`device-show ${shq(device)}`, device !== '', 60_000);
  const streams = (info.data?.endpointList ?? []).filter((endpoint) => endpoint.type === 'stream' && !endpoint.retired);
  const stream = streams.find((endpoint) => endpoint.name === params.get('stream')) ?? streams[0];

  const [tappedAt, setTappedAt] = useState<number>();
  const [status, setStatus] = useState<LiveStatus>();
  const wantsLive = alwaysLive || tappedAt !== undefined;
  const live = wantsLive && status?.state !== 'failed' && status?.state !== 'ended';
  const playing = live && status?.state === 'playing';
  const { frame, failed } = useFrames(device, stream?.name, everyMs, !playing);
  const onStatus = useCallback((next: LiveStatus) => setStatus(next), []);

  useEffect(() => {
    if (tappedAt === undefined) return;
    const timer = setTimeout(() => setTappedAt(undefined), TAPPED_LIVE_MS);
    return () => clearTimeout(timer);
  }, [tappedAt]);
  useEffect(() => setStatus(undefined), [wantsLive, stream?.name]);
  // A stream that stopped or could not be played is tried again a minute later.
  useEffect(() => {
    if (live || !wantsLive) return;
    const timer = setTimeout(() => setStatus(undefined), RETRY_LIVE_MS);
    return () => clearTimeout(timer);
  }, [live, wantsLive]);

  if (!info.data) {
    return info.error ? <Quiet icon='video-off'>{info.error.message}</Quiet> : <Skeleton h='100%' radius={0} />;
  }
  if (!stream) return <Quiet icon='video-off'>{info.data.label} sends no picture.</Quiet>;

  const toggle = () => alwaysLive ? undefined : setTappedAt(tappedAt === undefined ? Date.now() : undefined);
  const why = wantsLive && !live ? status?.reason ?? 'it cannot be played live' : undefined;
  const when = playing ? 'Live' : frame ? formatTime(new Date(frame.at).toISOString(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : undefined;
  const offline = info.data.online === false;

  return (
    <Box
      h='100%'
      pos='relative'
      onClick={toggle}
      title={alwaysLive ? undefined : tappedAt === undefined ? 'Watch it live' : 'Back to pictures'}
      style={{ overflow: 'hidden', background: 'black', cursor: alwaysLive ? undefined : 'pointer' }}
    >
      {frame && !playing && <img src={frame.url} alt={info.data.label} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: fit }} />}
      {live && (
        <LivePlayer
          key={stream.name}
          device={info.data.name}
          stream={stream.name}
          onStatus={onStatus}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: fit, visibility: playing ? 'visible' : 'hidden' }}
        />
      )}
      {!frame && !playing &&
        (failed ? <Quiet icon='video-off'>No picture from {info.data.label}{offline ? ', which does not answer' : ''}.</Quiet> : <Skeleton h='100%' radius={0} />)}
      <Box
        pos='absolute'
        bottom={0}
        left={0}
        right={0}
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: '0.6em',
          padding: '2em 0.9em 0.6em',
          background: 'linear-gradient(transparent, rgba(0, 0, 0, 0.7))',
          color: 'white',
          fontSize: 'clamp(0.75rem, 3.5cqmin, 1.2rem)',
          pointerEvents: 'none',
        }}
      >
        {playing && <TablerIcon name='point-filled' size='1em' color='var(--mantine-color-red-6)' style={{ alignSelf: 'center' }} />}
        <Text inherit fw={650} truncate style={{ flex: 1, minWidth: 0 }}>{params.get('label') || info.data.label}</Text>
        {(failed || offline) && !playing && frame && <TablerIcon name='alert-triangle' size='1em' color='var(--mantine-color-yellow-5)' style={{ alignSelf: 'center' }} />}
        {when && <Text inherit size='0.85em' c='rgba(255, 255, 255, 0.8)'>{when}</Text>}
      </Box>
      {why && (
        <Text
          size='xs'
          pos='absolute'
          top={8}
          left={8}
          right={8}
          c='white'
          style={{ background: 'rgba(0, 0, 0, 0.55)', borderRadius: 'var(--mantine-radius-sm)', padding: '0.25em 0.6em', pointerEvents: 'none' }}
        >
          Not live: {why}
        </Text>
      )}
    </Box>
  );
}
