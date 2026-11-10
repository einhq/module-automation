import { TablerIcon } from '@ein/ui/components';
import { shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import { ActionIcon, Badge, Box, Button, Group, ScrollArea, SegmentedControl, Stack, Text, TextInput, ThemeIcon, Tooltip } from '@mantine/core';
import { useEffect, useState } from 'react';
import type { DeviceInfo } from '@ein/api';
import type { AutomationValue as Value } from '../../lib/api.ts';
import { KINDS } from '../../lib/automations/catalog.ts';
import { readsOf } from '../../lib/automations/engine.ts';
import type { Automation, Node } from '../../lib/automations/graph.ts';
import { type SimEntry, Simulation } from './simulation.ts';

const MINUTE = 60_000;
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** A value typed in: a number, true or false as they are, any other text as text. */
const typed = (text: string): Value => {
  const trimmed = text.trim();
  if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true';
  return trimmed !== '' && Number.isFinite(Number(trimmed)) ? Number(trimmed) : trimmed;
};

const shownValue = (value: Value | undefined): string =>
  value === undefined ? '–' : value === null ? 'nothing' : typeof value === 'boolean' ? value ? 'on' : 'off' : String(value);

const clockText = (ms: number, seconds = true) =>
  new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });

const waitText = (ms: number) => ms < MINUTE ? `${Math.ceil(ms / 1000)} s` : ms < 3_600_000 ? `${Math.round(ms / MINUTE)} min` : `${Math.round(ms / 3_600_000)} h`;

/** What the automation would have done, beside the steps that led to it. */
const ACTIONS = new Set<SimEntry['kind']>(['control', 'shell', 'link', 'debug', 'error']);

/** The simulated time of an entry, to the second. */
const timeText = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** An entry about no node of the graph: an endpoint fed, a link's name. */
const ENTRY_ICONS: Record<SimEntry['kind'], string> = {
  input: 'arrow-big-right-lines',
  send: 'arrow-right',
  skip: 'player-pause',
  control: 'toggle-right',
  shell: 'terminal-2',
  link: 'link',
  debug: 'bug',
  error: 'alert-triangle',
  clock: 'clock',
};

const ENTRY_COLOURS: Record<SimEntry['kind'], string> = {
  send: 'gray',
  skip: 'gray',
  control: 'teal',
  shell: 'orange',
  link: 'grape',
  debug: 'gray',
  error: 'red',
  clock: 'indigo',
  input: 'blue',
};

/**
 * Start a simulation of `automation`, primed with what its devices said last: their readings and
 * whether they are there, read as the reader, never written.
 */
export async function startSimulation(automation: Automation): Promise<Simulation> {
  const sim = new Simulation(automation, TIME_ZONE, Date.now());
  const reads = readsOf(automation);
  const devices = [...new Set([...reads.endpoints, ...reads.controls].map((key) => key.split('/')[0]).concat(reads.devices))];
  const values = new Map<string, { value: Value; at: number }>();
  const online = new Map<string, boolean>();
  await Promise.all(devices.map(async (device) => {
    const info = await execCommand<DeviceInfo>(`device-show ${shq(device)}`).catch(() => undefined);
    if (!info) return;
    if (typeof info.online === 'boolean') online.set(device, info.online);
    for (const endpoint of info.endpointList) {
      if (endpoint.last && endpoint.type !== 'track') values.set(`${device}/${endpoint.name}`, { value: endpoint.last.value as Value, at: Date.parse(endpoint.last.at) });
    }
  }));
  sim.prime(values, online);
  return sim;
}

/** A reading or a press fed to a device node's endpoint, or a message to a link in. */
function ValueFeed({ placeholder, onSend, onPress }: { placeholder: string; onSend: (value: Value) => void; onPress?: (value: Value) => void }) {
  const [text, setText] = useState('');
  return (
    <Group gap={6} wrap='nowrap'>
      <TextInput
        size='xs'
        placeholder={placeholder}
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => event.key === 'Enter' && text.trim() && onSend(typed(text))}
        style={{ flex: 1 }}
        aria-label='Value'
      />
      <Button size='xs' variant='light' disabled={!text.trim()} onClick={() => onSend(typed(text))}>Send</Button>
      {onPress && (
        <Tooltip label='As a press of a button: a moment, not a state'>
          <Button size='xs' variant='default' disabled={!text.trim()} onClick={() => onPress(typed(text))}>Press</Button>
        </Tooltip>
      )}
    </Group>
  );
}

/** One input node of the automation, with what feeds it. */
function InputRow({ sim, node }: { sim: Simulation; node: Node }) {
  const kind = KINDS[node.type];
  const endpoint = node.config.endpoint as string | undefined;
  const device = node.config.device as string | undefined;
  let feed;
  let now: string | undefined;
  switch (node.type) {
    case 'device':
      now = shownValue(sim.values.get(endpoint!));
      feed = (
        <Stack gap={4}>
          <Group gap={4}>
            <Text size='xs' c='dimmed'>Send a reading</Text>
            {['on', 'off'].map((word) => (
              <Button
                key={word}
                size='compact-xs'
                variant='default'
                title={`The device reads ${word}, as when a sensor sees motion${word === 'off' ? ' no more' : ''} or a switch is turned ${word}`}
                onClick={() => sim.feed(endpoint!, word === 'on')}
              >
                {word}
              </Button>
            ))}
            {node.config.is !== undefined && (
              <Button
                size='compact-xs'
                variant='default'
                title={`A press of ${shownValue(node.config.is as Value)}, the one this node passes on`}
                onClick={() => sim.feed(endpoint!, node.config.is as Value, true)}
              >
                press {shownValue(node.config.is as Value)}
              </Button>
            )}
          </Group>
          <ValueFeed placeholder='21.5, open, single' onSend={(value) => sim.feed(endpoint!, value)} onPress={(value) => sim.feed(endpoint!, value, true)} />
        </Stack>
      );
      break;
    case 'online':
      feed = (
        <SegmentedControl
          size='xs'
          value={sim.online.get(device!) === false ? 'off' : sim.online.has(device!) ? 'on' : ''}
          onChange={(next) => sim.setOnline(device!, next === 'on')}
          data={[{ value: 'on', label: 'Online' }, { value: 'off', label: 'Offline' }]}
        />
      );
      break;
    case 'button':
      feed = <Button size='xs' variant='light' leftSection={<TablerIcon name='player-play' size={14} />} onClick={() => sim.press(node.id)}>Press</Button>;
      break;
    case 'clock': {
      const next = sim.nextClock(node.id);
      feed = next !== undefined && (
        <Button size='xs' variant='light' leftSection={<TablerIcon name='player-skip-forward' size={14} />} onClick={() => sim.advanceTo(next)}>
          On to {clockText(next, false)}
        </Button>
      );
      break;
    }
    case 'link-in':
      feed = <ValueFeed placeholder='what the link sends' onSend={(value) => sim.sendLink(node.config.name as string, value)} />;
      break;
    case 'between':
      now = sim.status()[node.id]?.value === true ? 'inside' : 'outside';
      break;
  }
  return (
    <Box p='xs' style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 'var(--mantine-radius-sm)' }}>
      <Group gap={8} wrap='nowrap' justify='space-between' mb={feed ? 6 : 0}>
        <Group gap={8} wrap='nowrap' style={{ minWidth: 0 }}>
          <ThemeIcon color={kind?.color ?? 'gray'} variant='light' size={24} radius='sm'>
            <TablerIcon name={kind?.icon ?? 'help'} size={14} />
          </ThemeIcon>
          <Box style={{ minWidth: 0 }}>
            <Text size='sm' fw={600} truncate>{node.id}</Text>
            <Text size='xs' c='dimmed' truncate>{endpoint ?? device ?? (node.config.name as string | undefined) ?? kind?.label}</Text>
          </Box>
        </Group>
        {now !== undefined && <Text size='sm' ff='monospace'>{now}</Text>}
      </Group>
      {feed}
    </Box>
  );
}

/**
 * The automation tried out: its clock, which keeps pace with the real one unless paused and can be
 * moved on; its inputs, each with what feeds it; what the simulated controls hold; and what it would
 * have done, newest first. Nothing here switches or runs anything real. The page draws it again
 * whenever the simulation changes (`sim.onChange`).
 */
export function Simulator({ sim, onClose }: { sim: Simulation; onClose: () => void }) {
  const [running, setRunning] = useState(true);
  const [only, setOnly] = useState<'all' | 'actions'>('all');
  // The clock keeps pace with the real one while it runs.
  useEffect(() => {
    if (!running) return;
    let wall = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      sim.advance(now - wall);
      wall = now;
    }, 1000);
    return () => clearInterval(timer);
  }, [sim, running]);

  const inputs = [...sim.automation.nodes.values()].filter((node) => ['device', 'online', 'clock', 'button', 'link-in', 'between'].includes(node.type));
  const controls = [...new Set([...sim.automation.nodes.values()].filter((node) => node.type === 'control').map((node) => node.config.endpoint as string))];
  const next = sim.nextTimer();
  const shownEntries = only === 'all' ? sim.entries : sim.entries.filter((entry) => ACTIONS.has(entry.kind));

  return (
    <Stack gap='sm'>
      <Group gap='sm' wrap='nowrap' align='flex-start'>
        <ThemeIcon color='grape' variant='light' size={36} radius='md'>
          <TablerIcon name='flask' size={20} />
        </ThemeIcon>
        <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
          <Text fw={600}>Simulation</Text>
          <Text size='xs' c='dimmed'>Started from the devices' latest readings. Nothing real is switched or run.</Text>
        </Stack>
        <Tooltip label='Stop simulating'>
          <ActionIcon variant='subtle' color='gray' size={32} onClick={onClose} aria-label='Stop simulating'>
            <TablerIcon name='x' size={18} />
          </ActionIcon>
        </Tooltip>
      </Group>

      <Box p='xs' style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 'var(--mantine-radius-sm)' }}>
        <Group justify='space-between' wrap='nowrap' mb={6}>
          <Tooltip label={`In this browser's time zone, ${TIME_ZONE}`}>
            <Text size='lg' fw={600} ff='monospace'>{clockText(sim.now)}</Text>
          </Tooltip>
          <Tooltip label={running ? 'Hold the clock' : 'Let the clock run'}>
            <ActionIcon variant='light' size={32} onClick={() => setRunning(!running)} aria-label={running ? 'Hold the clock' : 'Let the clock run'}>
              <TablerIcon name={running ? 'player-pause' : 'player-play'} size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
        <Group gap={4}>
          {[['+1 min', MINUTE], ['+10 min', 10 * MINUTE], ['+1 h', 60 * MINUTE]].map(([label, ms]) => (
            <Button
              key={label}
              size='compact-xs'
              variant='default'
              onClick={() => sim.advance(ms as number)}
            >
              {label}
            </Button>
          ))}
          {next !== undefined && (
            <Button size='compact-xs' variant='light' leftSection={<TablerIcon name='alarm' size={12} />} onClick={() => sim.advanceTo(next)}>
              Next timer, in {waitText(next - sim.now)}
            </Button>
          )}
        </Group>
      </Box>

      <Text size='sm' fw={600}>Inputs</Text>
      {inputs.length ? inputs.map((node) => <InputRow key={node.id} sim={sim} node={node} />) : <Text size='sm' c='dimmed'>It has no input: nothing starts it.</Text>}

      {controls.length > 0 && (
        <>
          <Text size='sm' fw={600}>Controls</Text>
          {controls.map((endpoint) => (
            <Group key={endpoint} justify='space-between' wrap='nowrap'>
              <Text size='sm' truncate>{endpoint}</Text>
              <Badge variant='light' color={sim.values.get(endpoint) === true ? 'teal' : 'gray'} ff='monospace'>{shownValue(sim.values.get(endpoint))}</Badge>
            </Group>
          ))}
        </>
      )}

      <Group justify='space-between' wrap='nowrap'>
        <Text size='sm' fw={600}>What happened</Text>
        <SegmentedControl
          size='xs'
          value={only}
          onChange={(next) => setOnly(next as 'all' | 'actions')}
          data={[{ value: 'all', label: 'Every step' }, { value: 'actions', label: 'What it would do' }]}
        />
      </Group>
      {shownEntries.length === 0
        ? <Text size='sm' c='dimmed'>{sim.entries.length ? 'Nothing it would do yet.' : 'Nothing yet: feed it an input.'}</Text>
        : (
          <ScrollArea.Autosize mah={420} type='auto' offsetScrollbars='y'>
            <Stack gap={6}>
              {shownEntries.map((entry, index) => {
                const node = sim.automation.nodes.get(entry.node);
                const kind = node ? KINDS[node.type] : undefined;
                return (
                  <Group key={index} gap={8} wrap='nowrap' align='flex-start'>
                    <Text size='xs' c='dimmed' ff='monospace' w={62} style={{ flex: '0 0 62px' }}>{timeText(entry.at)}</Text>
                    <ThemeIcon color={kind?.color ?? ENTRY_COLOURS[entry.kind]} variant='light' size={20} radius='sm' style={{ flex: '0 0 auto' }}>
                      <TablerIcon name={kind?.icon ?? ENTRY_ICONS[entry.kind]} size={12} />
                    </ThemeIcon>
                    <Text size='xs' c={entry.kind === 'skip' ? 'dimmed' : entry.kind === 'error' ? 'red' : undefined} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                      <Text span fw={600} size='xs'>{entry.node}</Text> {entry.text}
                      {ACTIONS.has(entry.kind) && entry.kind !== 'debug' && <Badge size='xs' variant='light' color={ENTRY_COLOURS[entry.kind]} ml={6}>{entry.kind}</Badge>}
                    </Text>
                  </Group>
                );
              })}
            </Stack>
          </ScrollArea.Autosize>
        )}
    </Stack>
  );
}
