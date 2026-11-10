import { EmptyState, ListFilterInput, PageBar, TablerIcon } from '@ein/ui/components';
import { usePhone, usePolledCommand } from '@ein/ui/hooks';
import { matchesText, shq } from '@ein/ui/lib';
import { execCommand, notify } from '@ein/ui/signals';
import { ActionIcon, Box, Button, Group, Modal, Paper, ScrollArea, Select, Stack, Tabs, Text, TextInput, Tooltip, UnstyledButton } from '@mantine/core';
import { type ReactNode, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { AutomationSetAnswer, AutomationSummary } from '@automation/api';
import { EXAMPLES } from '../../lib/automations/examples.ts';
import { AutomationEditor, type AutomationTab } from '../automation/Editor.tsx';

export const handle = { fullBleed: true, title: 'Automations', pattern: 'mixed' };

const stateOf = (each: AutomationSummary): { label: string; colour: string } =>
  each.problems.length
    ? { label: 'not running', colour: 'var(--mantine-color-red-6)' }
    : !each.enabled
    ? { label: 'off', colour: 'var(--mantine-color-gray-6)' }
    : each.running
    ? { label: 'running', colour: 'var(--mantine-color-teal-6)' }
    : { label: 'not running', colour: 'var(--mantine-color-yellow-6)' };

/** The automations, those whose name or description holds `filter`; `onPick` hears one opened. */
function AutomationRows({ list, active, filter, onPick }: { list: AutomationSummary[]; active?: string; filter: string; onPick: (name: string) => void }) {
  const shown = list.filter((each) => matchesText([each.name, each.description], filter));
  if (!shown.length) return <Text size='sm' c='dimmed' p='sm'>{filter ? 'No automations match' : 'No automations yet'}</Text>;
  return (
    <Stack gap={2}>
      {shown.map((each) => {
        const state = stateOf(each);
        return (
          <UnstyledButton
            key={each.name}
            onClick={() => onPick(each.name)}
            style={{ padding: '8px 10px', borderRadius: 'var(--mantine-radius-sm)', background: each.name === active ? 'var(--mrx-surface-raised)' : undefined }}
          >
            <Group gap={8} wrap='nowrap'>
              <Tooltip label={state.label}>
                <Box w={8} h={8} style={{ borderRadius: '50%', background: state.colour, flex: '0 0 8px' }} aria-label={state.label} />
              </Tooltip>
              <Box style={{ minWidth: 0 }}>
                <Text size='sm' truncate fw={each.name === active ? 600 : 400}>{each.name}</Text>
                <Text size='xs' c='dimmed' truncate>{each.problems[0]?.message ?? each.description ?? `${each.nodes} nodes · ${each.owner}`}</Text>
              </Box>
            </Group>
          </UnstyledButton>
        );
      })}
    </Stack>
  );
}

/** Make an automation, empty or from a starting point, and open it. */
function NewAutomation({ opened, onClose, onMade }: { opened: boolean; onClose: () => void; onMade: (name: string) => void }) {
  const [name, setName] = useState('');
  const [from, setFrom] = useState('empty');
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    try {
      const made = await execCommand<AutomationSetAnswer>(`automation-new ${shq(name.trim())} --from ${shq(from)}`);
      onMade(made.name);
      setName('');
    } catch (error) {
      notify({ message: error instanceof Error ? error.message : String(error), color: 'red' });
    } finally {
      setBusy(false);
    }
  };
  const example = EXAMPLES.find((each) => each.name === from);
  return (
    <Modal opened={opened} onClose={onClose} title='New automation'>
      <Stack>
        <TextInput label='Name' description='Letters, digits, ., - and _: hall-light' value={name} onChange={(event) => setName(event.currentTarget.value)} data-autofocus />
        <Select label='Start from' data={EXAMPLES.map((each) => ({ value: each.name, label: each.label }))} value={from} onChange={(next) => setFrom(next ?? 'empty')} />
        {example && <Text size='sm' c='dimmed'>{example.description}</Text>}
        <Group justify='flex-end'>
          <Button variant='default' onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={!name.trim()} onClick={() => void make()}>Make it</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** How wide the list of automations is, over the canvas's left edge. */
const DRAWER_WIDTH = 300;
/** How far the drawer's handle is dragged before it is a slide rather than a tap. */
const DRAG_THRESHOLD = 4;
/** How far a slide goes before the drawer, let go, slides the rest of the way. */
const SLIDE_THRESHOLD = 60;
/** Whether the list was last left open on a wide screen, as the viewer left it. */
const OPEN_KEY = 'automation.list-open';

const readOpen = () => {
  try {
    return localStorage.getItem(OPEN_KEY) !== 'false';
  } catch {
    return true;
  }
};
const keepOpen = (open: boolean) => {
  try {
    localStorage.setItem(OPEN_KEY, String(open));
  } catch {
    // Not kept: it opens as it does the first time.
  }
};

/**
 * A panel over the left edge of what is below the bar, slid off to the left and back by the handle
 * on its edge: tapped, or dragged and let go past `SLIDE_THRESHOLD`.
 */
function SlideDrawer({ open, onOpen, width, children }: { open: boolean; onOpen: (open: boolean) => void; width: number; children: ReactNode }) {
  const press = useRef<{ x: number; pointer: number; moved: boolean } | null>(null);
  const [slid, setSlid] = useState<number | null>(null);
  const rest = open ? 0 : -width;
  const at = slid === null ? rest : Math.min(0, Math.max(-width, rest + slid));
  const label = open ? 'Hide the automations' : 'Show the automations';
  return (
    <Box
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        width,
        zIndex: 3,
        transform: `translateX(${at}px)`,
        transition: slid === null ? 'transform 200ms ease' : 'none',
      }}
    >
      <Paper h='100%' radius={0} shadow={open ? 'md' : undefined} style={{ borderRight: '1px solid var(--mantine-color-default-border)', overflow: 'hidden' }} inert={!open}>
        {children}
      </Paper>
      <Tooltip label={label} position='right'>
        <UnstyledButton
          aria-label={label}
          aria-expanded={open}
          onPointerDown={(event) => {
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            press.current = { x: event.clientX, pointer: event.pointerId, moved: false };
          }}
          onPointerMove={(event) => {
            const current = press.current;
            if (!current || current.pointer !== event.pointerId) return;
            const dx = event.clientX - current.x;
            if (!current.moved && Math.abs(dx) < DRAG_THRESHOLD) return;
            current.moved = true;
            setSlid(dx);
          }}
          onPointerUp={(event) => {
            const current = press.current;
            press.current = null;
            setSlid(null);
            if (!current) return;
            const dx = event.clientX - current.x;
            if (!current.moved) onOpen(!open);
            else if (open && dx < -SLIDE_THRESHOLD) onOpen(false);
            else if (!open && dx > SLIDE_THRESHOLD) onOpen(true);
          }}
          onPointerCancel={() => {
            press.current = null;
            setSlid(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onOpen(!open);
            }
          }}
          style={{
            position: 'absolute',
            top: '50%',
            right: -22,
            width: 22,
            height: 64,
            marginTop: -32,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            touchAction: 'none',
            cursor: slid === null ? 'pointer' : 'grabbing',
            background: 'var(--mrx-surface-raised)',
            border: '1px solid var(--mantine-color-default-border)',
            borderLeft: 0,
            borderRadius: '0 var(--mantine-radius-md) var(--mantine-radius-md) 0',
            boxShadow: 'var(--mantine-shadow-xs)',
          }}
        >
          <TablerIcon name={open ? 'chevron-left' : 'chevron-right'} size={16} />
        </UnstyledButton>
      </Tooltip>
    </Box>
  );
}

/**
 * The automations: the one open fills what is below the bar, its graph, its YAML or what it did,
 * and the list of them is a drawer over its left edge that slides away. `/automations/<name>` opens
 * one, a module's as `<module>%2F<name>`. On a phone the drawer covers the canvas, and closes when
 * one is picked.
 */
export default function AutomationsPage() {
  const params = useParams();
  const name = params.name ? decodeURIComponent(params.name) : undefined;
  const navigate = useNavigate();
  const phone = usePhone();
  const { data, error, refetch } = usePolledCommand<AutomationSummary[]>('automations');
  const [filter, setFilter] = useState('');
  const [making, setMaking] = useState(false);
  const [tab, setTab] = useState<AutomationTab>('graph');
  const [listOpen, setListOpen] = useState(() => (phone ? !name : readOpen()));
  const [controls, setControls] = useState<HTMLElement | null>(null);
  const list = data ?? [];
  const open = (next: string) => {
    if (phone) setListOpen(false);
    navigate(`/automations/${encodeURIComponent(next)}`);
  };
  const slide = (next: boolean) => {
    setListOpen(next);
    if (!phone) keepOpen(next);
  };
  const width = phone ? Math.min(DRAWER_WIDTH, globalThis.innerWidth - 40) : DRAWER_WIDTH;

  return (
    <Paper
      radius={0}
      bg='var(--mrx-surface-base)'
      style={{
        height: 'calc(100dvh - var(--app-shell-header-offset, 48px))',
        // A phone's keyboard shrinks the viewport; a floor there would scroll the top bar away.
        minHeight: phone ? undefined : 420,
        overflow: 'hidden',
      }}
    >
      <Tabs value={tab} onChange={(next) => setTab((next ?? 'graph') as AutomationTab)} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <PageBar
          title={name ?? 'Automations'}
          pattern='mixed'
          controls={<Box ref={setControls} style={{ display: 'contents' }} />}
          tabs={name && (
            <Tabs.List>
              <Tabs.Tab value='graph' leftSection={<TablerIcon name='topology-star-3' size={16} />}>Graph</Tabs.Tab>
              <Tabs.Tab value='yaml' leftSection={<TablerIcon name='file-code' size={16} />}>YAML</Tabs.Tab>
              <Tabs.Tab value='runs' leftSection={<TablerIcon name='list-details' size={16} />}>Runs</Tabs.Tab>
            </Tabs.List>
          )}
        />
        <Box style={{ position: 'relative', flex: 1, minHeight: 0 }}>
          {name
            ? <AutomationEditor key={name} name={name} tab={tab} controls={controls} inset={!phone && listOpen ? DRAWER_WIDTH : 0} onChanged={() => void refetch()} />
            : (
              <Box h='100%' pl={!phone && listOpen ? DRAWER_WIDTH : 0}>
                <EmptyState
                  title='Automations'
                  actions={<Button leftSection={<TablerIcon name='plus' size={16} />} onClick={() => setMaking(true)}>New automation</Button>}
                >
                  Nodes wired together that switch things, run command lines and keep time when a reading, a press or the clock says so. Pick one, or make one.
                </EmptyState>
              </Box>
            )}
          <SlideDrawer open={listOpen} onOpen={slide} width={width}>
            <Stack gap='xs' h='100%' p='sm'>
              <Group gap='xs' wrap='nowrap'>
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <ListFilterInput value={filter} onChange={setFilter} what='automations' size='sm' />
                </Box>
                <Tooltip label='New automation'>
                  <ActionIcon variant='light' size={36} onClick={() => setMaking(true)} aria-label='New automation'>
                    <TablerIcon name='plus' size={20} />
                  </ActionIcon>
                </Tooltip>
              </Group>
              <ScrollArea type='auto' scrollbars='y' offsetScrollbars='y' style={{ flex: 1, minHeight: 0 }}>
                {error ? <Text size='sm' c='red' p='sm'>{error.message}</Text> : <AutomationRows list={list} active={name} filter={filter} onPick={open} />}
              </ScrollArea>
            </Stack>
          </SlideDrawer>
        </Box>
      </Tabs>
      <NewAutomation
        opened={making}
        onClose={() => setMaking(false)}
        onMade={(made) => {
          setMaking(false);
          void refetch();
          open(made);
        }}
      />
    </Paper>
  );
}
