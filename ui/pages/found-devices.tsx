import { EmptyState, EntityDetailHeader, HeaderChoice, HeaderFilterBar, HeaderStats, ListFilterInput, PageLoader, TablerIcon } from '@ein/ui/components';
import { usePersistedState, usePolledCommand, useUrlParam } from '@ein/ui/hooks';
import { countOf, matchesText, shq } from '@ein/ui/lib';
import { execCommand, notify } from '@ein/ui/signals';
import { Alert, Badge, Box, Button, Card, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { FoundAnswer, FoundDevice } from '@automation/api';

export const handle = { fullBleed: true };

type Scope = 'addable' | 'new' | 'all';

/** The icon of each kind of thing on the network. */
const ICONS: Record<string, string> = {
  shelly: 'plug',
  'shelly-gen1': 'plug',
  esphome: 'cpu',
  tasmota: 'cpu',
  matter: 'home-link',
  homekit: 'home',
  hue: 'bulb',
  sonos: 'speakerphone',
  cast: 'cast',
  airplay: 'cast',
  printer: 'printer',
  router: 'router',
  media: 'device-tv',
  storage: 'server',
};

const failed = (error: unknown) => notify({ message: error instanceof Error ? error.message : String(error), color: 'red' });

const agoText = (iso: string): string => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return minutes < 1 ? 'just now' : minutes < 120 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
};

function FoundCard({ found, onChanged }: { found: FoundDevice; onChanged: () => void }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<'add' | 'ignore' | null>(null);
  const what = [found.vendor, found.model].filter(Boolean).join(' ');

  const run = async (kind: 'add' | 'ignore', command: string, done?: string) => {
    setBusy(kind);
    try {
      await execCommand(command);
      if (done) notify({ message: done, color: 'green' });
      onChanged();
    } catch (error) {
      failed(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card radius='md' p='md' withBorder style={{ display: 'flex', flexDirection: 'column' }}>
      <Group gap='sm' wrap='nowrap' align='flex-start'>
        <TablerIcon name={ICONS[found.kind] ?? 'device-unknown'} size={28} />
        <Box style={{ minWidth: 0 }}>
          <Text fw={600} truncate='end'>{found.label}</Text>
          {what && <Text size='sm' c='dimmed' truncate='end'>{what}</Text>}
          <Text size='xs' c='dimmed'>{[found.ip, found.mac].filter(Boolean).join(' · ')}</Text>
        </Box>
      </Group>
      <Group gap={4} mt='sm'>
        {found.device && <Badge size='xs' variant='light' color='green'>device</Badge>}
        {found.ignored && <Badge size='xs' variant='light' color='gray'>ignored</Badge>}
        {!found.device && found.addable && <Badge size='xs' variant='light' color='orange'>can be added</Badge>}
        {found.firmware && <Badge size='xs' variant='light' color='gray'>{found.firmware}</Badge>}
        <Badge size='xs' variant='light' color='gray'>seen {agoText(found.seen)}</Badge>
      </Group>
      {found.connect && !found.device && <Text size='xs' c='dimmed' mt='sm'>{found.connect}</Text>}
      <Group gap='xs' mt='auto' pt='sm'>
        {found.device && (
          <Button size='xs' variant='light' onClick={() => navigate(`/devices/${encodeURIComponent(found.device!)}`)}>
            Open
          </Button>
        )}
        {!found.device && found.adopt && (
          <Button
            size='xs'
            loading={busy === 'add'}
            disabled={busy !== null}
            leftSection={<TablerIcon name='plus' size={14} />}
            onClick={() => run('add', `automation-adopt ${shq(found.id)}`, `${found.label} is restarting; it shows up under Devices when it is back`)}
          >
            Add
          </Button>
        )}
        {!found.device && (
          <Button
            size='xs'
            variant='subtle'
            color='gray'
            loading={busy === 'ignore'}
            disabled={busy !== null}
            onClick={() => run('ignore', `automation-ignore ${shq(found.id)}${found.ignored ? ' --undo' : ''}`)}
          >
            {found.ignored ? 'Take back' : 'Ignore'}
          </Button>
        )}
      </Group>
    </Card>
  );
}

/**
 * What the network listener found on the network, as the people page's unidentified people: the
 * ones that can become a device first, each with Add where EiN can point it at the broker itself
 * and Ignore for the ones no one wants.
 */
export default function FoundDevicesPage() {
  const [search, setSearch] = useUrlParam('q');
  const [scope, setScope] = usePersistedState<Scope>('found-devices.scope', 'addable');
  const { data, loading, error, refetch } = usePolledCommand<FoundAnswer>('automation-found --all');
  const all = useMemo(() => data?.devices ?? [], [data]);

  const shown = useMemo(() =>
    all.filter((each) =>
      (scope === 'all' || (!each.device && !each.ignored && (scope === 'new' || each.addable))) &&
      matchesText([each.label, each.vendor, each.model, each.ip, each.mac, each.kind], search)
    ), [all, scope, search]);
  const addable = all.filter((each) => each.addable && !each.device && !each.ignored).length;

  return (
    <Box>
      <EntityDetailHeader
        title='Found on the network'
        pattern='device'
        meta={data && <HeaderStats items={[countOf(all.length, 'address', 'addresses'), `${addable} can be added`]} />}
        flowContent
        controls={
          <HeaderFilterBar input={<ListFilterInput value={search} onChange={setSearch} what='found devices' />}>
            <HeaderChoice
              label='Show'
              value={scope}
              onChange={(next) => setScope(next as Scope)}
              options={[
                { value: 'addable', label: 'Can be added', icon: <TablerIcon name='plus' size={18} /> },
                { value: 'new', label: 'Not a device yet', icon: <TablerIcon name='radar' size={18} /> },
                { value: 'all', label: 'Everything', icon: <TablerIcon name='list' size={18} /> },
              ]}
            />
          </HeaderFilterBar>
        }
      />
      <Box px='md' py='lg'>
        <Stack gap='lg'>
          {error && <Alert icon={<TablerIcon name='alert-circle' size={16} />} color='red'>{error.message}</Alert>}
          {data && !data.round && (
            <Alert icon={<TablerIcon name='info-circle' size={16} />} color='blue'>
              The network listener has not been heard. It runs beside the MQTT broker, which setup.sh --mqtt adds.
            </Alert>
          )}
          {loading && !data ? <PageLoader /> : (
            <>
              <SimpleGrid cols={{ base: 1, xs: 2, md: 3, lg: 4 }}>
                {shown.map((found) => <FoundCard key={found.id} found={found} onChanged={refetch} />)}
              </SimpleGrid>
              {data && shown.length === 0 && (
                <EmptyState title={scope === 'addable' ? 'Nothing to add' : 'Nothing found'}>
                  {scope === 'addable'
                    ? 'Every device found that EiN can take is a device already. Show everything to see the rest of the network.'
                    : 'What answers on the network over mDNS and SSDP shows up here within a few minutes.'}
                </EmptyState>
              )}
            </>
          )}
        </Stack>
      </Box>
    </Box>
  );
}
