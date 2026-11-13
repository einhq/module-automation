import { Alert, Box, Group, SegmentedControl, Stack, Text } from '@mantine/core';
import { EmptyState, PageLoader, TablerIcon } from '@ein/ui/components';
import { useCommand } from '@ein/ui/hooks';
import type { DeviceInfo, EndpointSummary } from '@ein/api';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LivePlayer, type LiveStatus } from '../cameras/LivePlayer.tsx';

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
  const [status, setStatus] = useState<LiveStatus>({ state: 'connecting' });
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
          {status.state === 'connecting'
            ? 'Connecting…'
            : status.state === 'playing'
            ? status.reason ?? 'Live'
            : status.state === 'ended'
            ? 'The stream ended'
            : status.reason}
        </Text>
      </Group>
      <Box>
        <LivePlayer
          key={stream.name}
          device={name}
          stream={stream.name}
          onStatus={setStatus}
          controls
          style={{ width: '100%', maxHeight: 'calc(100dvh - 280px)', borderRadius: 'var(--mantine-radius-sm)' }}
        />
      </Box>
    </Stack>
  );
}
