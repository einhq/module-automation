import { EmptyState, EntityDetailHeader, HeaderChoice, HeaderFilterBar, HeaderStats, ListFilterInput, PageLoader, TablerIcon } from '@ein/ui/components';
import { usePersistedState, usePolledCommand, useUrlParam } from '@ein/ui/hooks';
import { countOf, matchesText, shq } from '@ein/ui/lib';
import { execCommand, notify, openDialog } from '@ein/ui/signals';
import { Alert, Badge, Box, Button, Card, Group, PasswordInput, Popover, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AdoptAnswer, FoundAnswer, FoundDevice } from '@automation/api';

export const handle = { fullBleed: true };

type Scope = 'addable' | 'new' | 'all';

/** The icon of each kind of thing on the network. */
const ICONS: Record<string, string> = {
  camera: 'camera',
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

function FoundCard({ found, onChanged, onOpen }: { found: FoundDevice; onChanged: () => void; onOpen: () => void }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<'add' | 'ignore' | null>(null);
  /** A camera's sign-in, asked before it is added. */
  const [signIn, setSignIn] = useState<{ user: string; password: string } | null>(null);
  const what = [found.vendor, found.model].filter(Boolean).join(' ');

  const ignore = async () => {
    setBusy('ignore');
    try {
      await execCommand(`automation-ignore ${shq(found.id)}${found.ignored ? ' --undo' : ''}`);
      onChanged();
    } catch (error) {
      failed(error);
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    setBusy('add');
    try {
      const account = signIn ? ` --user ${shq(signIn.user)} --password ${shq(signIn.password)}` : '';
      const added = await execCommand<AdoptAnswer>(`automation-adopt ${shq(found.id)}${account}`);
      setSignIn(null);
      if (added.device) {
        const device = added.device;
        notify({ message: `${found.label} is a device now`, color: 'green', action: { label: 'Open', onClick: () => navigate(`/devices/${encodeURIComponent(device)}`) } });
      } else {
        notify({ message: `${found.label} is restarting; it shows up under Devices when it is back`, color: 'green' });
      }
      onChanged();
    } catch (error) {
      failed(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card radius='md' p='md' withBorder style={{ display: 'flex', flexDirection: 'column', cursor: 'pointer' }} onClick={onOpen}>
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
      <Group gap='xs' mt='auto' pt='sm' onClick={(event) => event.stopPropagation()}>
        {found.device && (
          <Button size='xs' variant='light' onClick={() => navigate(`/devices/${encodeURIComponent(found.device!)}`)}>
            Open
          </Button>
        )}
        {!found.device && found.adopt && found.adopt !== 'onvif' && (
          <Button
            size='xs'
            loading={busy === 'add'}
            disabled={busy !== null}
            leftSection={<TablerIcon name='plus' size={14} />}
            onClick={add}
          >
            Add
          </Button>
        )}
        {!found.device && found.adopt === 'onvif' && (
          <Popover
            opened={signIn !== null}
            onChange={(opened) => !opened && setSignIn(null)}
            position='bottom-start'
            withArrow
            trapFocus
          >
            <Popover.Target>
              <Button
                size='xs'
                disabled={busy !== null}
                leftSection={<TablerIcon name='plus' size={14} />}
                onClick={() => setSignIn(signIn ? null : { user: 'admin', password: '' })}
              >
                Add
              </Button>
            </Popover.Target>
            <Popover.Dropdown>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  add();
                }}
              >
                <Stack gap='xs' w={220}>
                  <Text size='xs' c='dimmed'>The account EiN signs in to the camera with</Text>
                  <TextInput
                    size='xs'
                    label='User'
                    value={signIn?.user ?? ''}
                    onChange={(event) => setSignIn({ user: event.currentTarget.value, password: signIn?.password ?? '' })}
                  />
                  <PasswordInput
                    size='xs'
                    label='Password'
                    value={signIn?.password ?? ''}
                    onChange={(event) => setSignIn({ user: signIn?.user ?? '', password: event.currentTarget.value })}
                  />
                  <Button size='xs' type='submit' loading={busy === 'add'}>Add camera</Button>
                </Stack>
              </form>
            </Popover.Dropdown>
          </Popover>
        )}
        {!found.device && (
          <Button
            size='xs'
            variant='subtle'
            color='gray'
            loading={busy === 'ignore'}
            disabled={busy !== null}
            onClick={ignore}
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
 * ones that can become a device first, each with Add where EiN can add it itself and Ignore for the
 * ones no one wants. A card opens everything the listener heard of it (`/found-devices/:id`) as a
 * dialog.
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
              The network listener has not been heard. It runs in the automation sidecar beside the MQTT broker, which setup.sh --automation adds.
            </Alert>
          )}
          {loading && !data ? <PageLoader /> : (
            <>
              <SimpleGrid cols={{ base: 1, xs: 2, md: 3, lg: 4 }}>
                {shown.map((found) => (
                  <FoundCard
                    key={found.id}
                    found={found}
                    onChanged={refetch}
                    onOpen={() => openDialog(`/found-devices/${encodeURIComponent(found.id)}`)}
                  />
                ))}
              </SimpleGrid>
              {data && shown.length === 0 && (
                <EmptyState title={scope === 'addable' ? 'Nothing to add' : 'Nothing found'}>
                  {scope === 'addable'
                    ? 'Every device found that EiN can take is a device already. Show everything to see the rest of the network.'
                    : 'What answers on the network over mDNS, SSDP and WS-Discovery shows up here within a few minutes.'}
                </EmptyState>
              )}
            </>
          )}
        </Stack>
      </Box>
    </Box>
  );
}
