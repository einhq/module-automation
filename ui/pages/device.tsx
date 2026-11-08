import { Alert, Anchor, Badge, Box, Button, Card, Container, Group, SegmentedControl, Select, SimpleGrid, Stack, Switch, Table, Tabs, Text, TextInput } from '@mantine/core';
import { Chart, EmptyState, EntityDetailHeader, PageLoader, StatTile, TablerIcon } from '@ein/ui/components';
import { shq } from '@ein/ui/lib';
import { usePolledCommand } from '@ein/ui/hooks';
import { execCommand, notify } from '@ein/ui/signals';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { DeviceHistory, DeviceInfo, EntitySummary } from '../../lib/api.ts';
import { TrackerSetup } from '../components/TrackerSetup.tsx';
import { agoText, chartLabel, readingText } from '../lib/format.ts';

const TABS = ['overview', 'history', 'info'] as const;
type Tab = typeof TABS[number];

/** The spans the History tab offers, each with the interval its readings are summed up per. */
const SPANS = {
  day: { since: '1d', bucket: '15m', label: 'Day' },
  week: { since: '7d', bucket: '2h', label: 'Week' },
  month: { since: '30d', bucket: '6h', label: 'Month' },
  year: { since: '365d', bucket: '1d', label: 'Year' },
} as const;
type Span = keyof typeof SPANS;

const failed = (error: unknown) => notify({ message: error instanceof Error ? error.message : String(error), color: 'red' });

/** The last few hours of a numeric entity, for its tile's sparkline. */
function useSparkline(device: string, entity: EntitySummary): { at: number; value: number }[] | undefined {
  const [series, setSeries] = useState<{ at: number; value: number }[]>();
  const numeric = entity.kind === 'sensor' && typeof entity.last?.value === 'number';
  useEffect(() => {
    if (!numeric) return;
    execCommand<DeviceHistory>(`device-history ${shq(`${device}/${entity.name}`)} --since 6h --bucket 10m`)
      .then((history) => setSeries(history.readings.flatMap((reading) => typeof reading.value === 'number' ? [{ at: Date.parse(reading.at), value: reading.value }] : [])))
      .catch(() => setSeries(undefined));
  }, [device, entity.name, entity.last?.at, numeric]);
  return series;
}

/** One entity on the Overview: a tile for a reading, a toggle for what can be switched, the last press of a button. */
function EntityTile({ device, entity, onChanged }: { device: string; entity: EntitySummary; onChanged: () => void }) {
  const series = useSparkline(device, entity);
  const [busy, setBusy] = useState(false);
  const target = `${device}/${entity.name}`;
  const set = async (value: string) => {
    setBusy(true);
    try {
      await execCommand(`device-set ${shq(target)} ${shq(value)}`);
      onChanged();
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  };

  if (entity.kind === 'position') {
    return (
      <Card withBorder radius='md' p='md'>
        <Text size='sm' c='dimmed'>{entity.label}</Text>
        <Text fw={500}>{entity.track ? `${entity.track.points.toLocaleString()} fixes` : 'no track'}</Text>
        {entity.track?.lastAt && <Text size='xs' c='dimmed'>last {agoText(entity.track.lastAt)}</Text>}
        {entity.track && <Anchor component={Link} to={`/tracks/${encodeURIComponent(entity.track.path)}`} size='sm'>Track and trips</Anchor>}
      </Card>
    );
  }
  if ((entity.kind === 'switch' || entity.kind === 'light') && entity.settable) {
    return (
      <Card withBorder radius='md' p='md'>
        <Group justify='space-between' wrap='nowrap'>
          <Box>
            <Text size='sm' c='dimmed'>{entity.label}</Text>
            <Text size='xs' c='dimmed'>{entity.last ? agoText(entity.last.at) : ''}</Text>
          </Box>
          <Switch
            size='lg'
            checked={entity.last?.value === true}
            disabled={busy}
            onChange={(event) => set(event.currentTarget.checked ? 'on' : 'off')}
            aria-label={entity.label}
          />
        </Group>
      </Card>
    );
  }
  if (entity.kind === 'action' && entity.settable) {
    return (
      <Card withBorder radius='md' p='md'>
        <Text size='sm' c='dimmed' mb='xs'>{entity.label}</Text>
        <Button size='compact-sm' variant='light' loading={busy} onClick={() => set('press')}>Press</Button>
      </Card>
    );
  }
  if (entity.kind === 'button') {
    return (
      <StatTile
        label={entity.label}
        value={entity.last ? String(entity.last.value) : '–'}
        hint={entity.last ? `pressed ${agoText(entity.last.at)}` : 'not pressed yet'}
        icon={<TablerIcon name='hand-click' size={18} />}
      />
    );
  }
  return (
    <StatTile
      label={entity.label}
      value={readingText(entity.last?.value, entity.unit)}
      hint={entity.last ? agoText(entity.last.at) : 'no reading yet'}
      series={series}
      seriesMax={series?.length ? Math.max(...series.map((point) => point.value)) : undefined}
      seriesUnit={entity.unit ?? ''}
    />
  );
}

function Overview({ info, onChanged }: { info: DeviceInfo; onChanged: () => void }) {
  const shown = info.entityList.filter((entity) => !entity.retired && !entity.category);
  const other = info.entityList.filter((entity) => !entity.retired && entity.category);
  if (shown.length + other.length === 0) return <EmptyState title='No entities'>The device has announced nothing it reads or can do yet.</EmptyState>;
  return (
    <Stack gap='lg'>
      <SimpleGrid cols={{ base: 1, xs: 2, md: 3, lg: 4 }}>
        {shown.map((entity) => <EntityTile key={entity.name} device={info.name} entity={entity} onChanged={onChanged} />)}
      </SimpleGrid>
      {other.length > 0 && (
        <>
          <Text size='sm' c='dimmed'>About the device itself</Text>
          <SimpleGrid cols={{ base: 1, xs: 2, md: 3, lg: 4 }}>
            {other.map((entity) => <EntityTile key={entity.name} device={info.name} entity={entity} onChanged={onChanged} />)}
          </SimpleGrid>
        </>
      )}
    </Stack>
  );
}

/**
 * An entity's readings over a span, summed up per interval: the average of a reading, the share of
 * time on of a switch. The device's main reading is charted first.
 */
function History({ info }: { info: DeviceInfo }) {
  const charted = info.entityList.filter((entity) => !entity.retired && ['sensor', 'binary', 'switch', 'light', 'number'].includes(entity.kind));
  const [entity, setEntity] = useState<string | null>((charted.find((each) => each.name === info.main?.entity) ?? charted[0])?.name ?? null);
  const [span, setSpan] = useState<Span>('day');
  const [history, setHistory] = useState<DeviceHistory>();
  useEffect(() => {
    if (!entity) return;
    const { since, bucket } = SPANS[span];
    execCommand<DeviceHistory>(`device-history ${shq(`${info.name}/${entity}`)} --since ${since} --bucket ${bucket} -n 2000`)
      .then(setHistory)
      .catch(failed);
  }, [info.name, entity, span]);
  if (!charted.length) return <EmptyState title='Nothing to chart'>The device has no readings or states kept over time.</EmptyState>;
  const points = (history?.readings ?? []).flatMap((reading) => typeof reading.value === 'number' ? [{ label: chartLabel(reading.at), value: reading.value }] : []);
  const chosen = charted.find((each) => each.name === entity);
  return (
    <Stack gap='md'>
      <Group>
        <Select
          data={charted.map((each) => ({ value: each.name, label: each.label }))}
          value={entity}
          onChange={setEntity}
          allowDeselect={false}
          w={240}
          aria-label='Entity'
        />
        <SegmentedControl value={span} onChange={(next) => setSpan(next as Span)} data={Object.entries(SPANS).map(([value, { label }]) => ({ value, label }))} />
      </Group>
      {points.length
        ? <Chart chart={{ kind: 'line', title: chosen?.label, unit: chosen?.kind === 'sensor' || chosen?.kind === 'number' ? chosen.unit : 'share on', points }} />
        : <Text c='dimmed'>No readings in this span.</Text>}
    </Stack>
  );
}

function Info({ info, onChanged }: { info: DeviceInfo; onChanged: () => void }) {
  const navigate = useNavigate();
  const [label, setLabel] = useState(info.label);
  const rename = async () => {
    try {
      await execCommand(`device-label ${shq(info.name)} ${shq(label)}`);
      onChanged();
    } catch (error) {
      failed(error);
    }
  };
  const forget = async () => {
    if (!globalThis.confirm(`Forget ${info.label} and all it has kept? A device that is still on comes back when it announces itself.`)) return;
    try {
      await execCommand(`device-forget ${shq(info.name)}`);
      navigate('/devices');
    } catch (error) {
      failed(error);
    }
  };
  const rows: [string, string | undefined][] = [
    ['Name', info.name],
    ['Found by', info.source],
    ['Manufacturer', info.manufacturer],
    ['Model', info.model],
    ['Firmware', info.sw],
    ['MAC', info.mac],
  ];
  return (
    <Stack gap='lg' maw={720}>
      <Table>
        <Table.Tbody>
          {rows.filter(([, value]) => value).map(([name, value]) => (
            <Table.Tr key={name}>
              <Table.Td c='dimmed' w={160}>{name}</Table.Td>
              <Table.Td>{value}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Entity</Table.Th>
            <Table.Th>Kind</Table.Th>
            <Table.Th>Value</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {info.entityList.map((entity) => (
            <Table.Tr key={entity.name}>
              <Table.Td>
                {entity.label} <Text span size='xs' c='dimmed'>{entity.name}</Text>
              </Table.Td>
              <Table.Td>
                {entity.kind}
                {entity.settable && <Badge ml='xs' size='xs' variant='light'>settable</Badge>}
                {!entity.supported && <Badge ml='xs' size='xs' variant='light' color='yellow'>not read</Badge>}
                {entity.retired && <Badge ml='xs' size='xs' variant='light' color='gray'>retired</Badge>}
              </Table.Td>
              <Table.Td>{readingText(entity.last?.value, entity.unit)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {(info.source === 'manual' || info.entityList.some((entity) => entity.kind === 'position')) && (
        <Box>
          <Text fw={500} mb='xs'>Live tracking</Text>
          <TrackerSetup device={info.name} />
        </Box>
      )}
      <Group align='end'>
        <TextInput label='Called' value={label} onChange={(event) => setLabel(event.currentTarget.value)} w={280} />
        <Button variant='light' onClick={rename} disabled={!label.trim() || label === info.label}>Rename</Button>
        <Button variant='subtle' color='red' onClick={forget} leftSection={<TablerIcon name='trash' size={16} />}>Forget</Button>
      </Group>
    </Stack>
  );
}

/** The page draws its own band edge to edge. */
export const handle = { fullBleed: true };

/** A device: its entities as they are now, their history, and what it is. */
export default function DevicePage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.includes(params.get('tab') as Tab) ? params.get('tab') as Tab : 'overview';
  const { data: info, loading, error, refetch } = usePolledCommand<DeviceInfo>(`device-show ${shq(id)}`);
  const refresh = () => void refetch();

  if (loading && !info) return <PageLoader />;
  if (!info) {
    return (
      <Container py='xl'>
        <Anchor component={Link} to='/devices'>← Devices</Anchor>
        <Alert mt='md' color='red'>{error?.message ?? `No device ${id}`}</Alert>
      </Container>
    );
  }
  return (
    <Tabs value={tab} onChange={(next) => setParams({ tab: next ?? 'overview' })} keepMounted={false}>
      <EntityDetailHeader
        title={info.label}
        pattern='device'
        subtitle={[info.manufacturer, info.model].filter(Boolean).join(' ') || undefined}
        meta={
          <Group gap='xs'>
            {info.online === true && <Badge variant='light' color='green'>online</Badge>}
            {info.online === false && <Badge variant='light' color='red'>offline</Badge>}
            {info.lastAt && <Text size='sm' c='dimmed'>last reading {agoText(info.lastAt)}</Text>}
          </Group>
        }
        tabs={
          <Tabs.List>
            <Tabs.Tab value='overview'>Overview</Tabs.Tab>
            <Tabs.Tab value='history'>History</Tabs.Tab>
            <Tabs.Tab value='info'>Info</Tabs.Tab>
          </Tabs.List>
        }
      />
      <Container size='xl' py='md' px='md'>
        <Tabs.Panel value='overview'>
          <Overview info={info} onChanged={refresh} />
        </Tabs.Panel>
        <Tabs.Panel value='history'>
          <History info={info} />
        </Tabs.Panel>
        <Tabs.Panel value='info'>
          <Info info={info} onChanged={refresh} />
        </Tabs.Panel>
      </Container>
    </Tabs>
  );
}
