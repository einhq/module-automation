import { CodeMirror, Dialog, DialogActions, EmptyState, PageLoader, TablerIcon } from '@ein/ui/components';
import { useLogFollow, usePhone } from '@ein/ui/hooks';
import { formatDateTime, shq } from '@ein/ui/lib';
import { execCommand, notify } from '@ein/ui/signals';
import { ActionIcon, Badge, Box, Button, Drawer, Group, Loader, Menu, Paper, Popover, ScrollArea, Stack, Switch, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AutomationDetail, AutomationNodeStatus, AutomationProblem, AutomationRunStatus, AutomationSetAnswer, AutomationSpec } from '../../lib/api.ts';
import { KINDS } from '../../lib/automations/catalog.ts';
import { readAutomation } from '../../lib/automations/graph.ts';
import { Canvas, type Selection, useDeleteKey } from './Canvas.tsx';
import { addNode, disconnect, nameProblem, removeNode, renameNode, setSettings } from './graph-edit.ts';
import { NodeForm } from './NodeForm.tsx';
import { GROUPS, NodeKinds } from './NodeKinds.tsx';
import type { Simulation } from './simulation.ts';
import { Simulator, startSimulation } from './Simulator.tsx';

export type AutomationTab = 'graph' | 'yaml' | 'runs';

/** How often a running automation's nodes are asked what they did, while its graph is open. */
const STATUS_MS = 3000;
/** How long the graph rests after a change before it is saved: a card dragged saves once it has settled. */
const GRAPH_SAVE_MS = 1000;
/** How long after the last keystroke the YAML is saved: long enough to finish a word. */
const YAML_SAVE_MS = 1500;

const failed = (error: unknown) => notify({ message: error instanceof Error ? error.message : String(error), color: 'red' });

/** How wide the panel of the node tapped is, over the canvas's right edge. */
const FORM_WIDTH = 400;

/** The kinds of node to add, by group, in a menu from a button on the canvas: a phone's, where the panel is a drawer. */
function Palette({ onAdd, phone }: { onAdd: (type: string) => void; phone: boolean }) {
  const kinds = Object.values(KINDS);
  return (
    <Menu shadow='md' width={260} position='left-start'>
      <Menu.Target>
        <Tooltip label='Add a node' position='left' disabled={phone}>
          <ActionIcon variant='filled' color='dark' size={36} aria-label='Add a node'>
            <TablerIcon name='plus' size={18} />
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown style={{ maxHeight: '70dvh', overflowY: 'auto' }}>
        {GROUPS.map(({ group, label }) => (
          <Box key={group}>
            <Menu.Label>{label}</Menu.Label>
            {kinds.filter((kind) => kind.group === group).map((kind) => (
              <Tooltip key={kind.type} label={kind.description} position='left' openDelay={400} multiline w={240} disabled={phone}>
                <Menu.Item
                  leftSection={<TablerIcon name={kind.icon} size={16} color={`var(--mantine-color-${kind.color}-filled)`} />}
                  onClick={() =>
                    onAdd(kind.type)}
                >
                  {kind.label}
                </Menu.Item>
              </Tooltip>
            ))}
          </Box>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

/**
 * How many problems an automation has, a label that opens them; one about a node, tapped, picks
 * that node when `onPick` is given.
 */
function Problems({ problems, phone, onPick }: { problems: AutomationProblem[]; phone: boolean; onPick?: (node: string) => void }) {
  const [opened, setOpened] = useState(false);
  const count = `${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}`;
  return (
    <Popover opened={opened} onChange={setOpened} position='bottom-end' shadow='md' width={340} withArrow>
      <Popover.Target>
        <Badge
          component='button'
          type='button'
          color='red'
          variant='filled'
          size='lg'
          aria-label={count}
          onClick={() => setOpened((was) => !was)}
          leftSection={<TablerIcon name='alert-triangle' size={14} />}
          rightSection={<TablerIcon name={opened ? 'chevron-up' : 'chevron-down'} size={12} />}
          style={{ cursor: 'pointer', flex: '0 0 auto' }}
        >
          {phone ? problems.length : count}
        </Badge>
      </Popover.Target>
      <Popover.Dropdown p={4}>
        <ScrollArea.Autosize mah={360} type='auto'>
          <Stack gap={0}>
            {problems.map((problem, index) => {
              const line = (
                <>
                  {problem.node && <Text size='sm' fw={600}>{problem.node}</Text>}
                  <Text size='sm'>{problem.message}</Text>
                </>
              );
              const node = problem.node;
              return node && onPick
                ? (
                  <UnstyledButton
                    key={index}
                    className='mrx-hover-row'
                    p={8}
                    style={{ borderRadius: 'var(--mantine-radius-sm)' }}
                    onClick={() => {
                      onPick(node);
                      setOpened(false);
                    }}
                  >
                    {line}
                  </UnstyledButton>
                )
                : <Box key={index} p={8}>{line}</Box>;
            })}
          </Stack>
        </ScrollArea.Autosize>
      </Popover.Dropdown>
    </Popover>
  );
}

/** An automation's run log, newest first: its actions, errors, debug nodes and clock firings. */
function Runs({ path }: { path: string }) {
  const { entries } = useLogFollow(path, { tail: 200, keep: 500 });
  if (!entries.length) return <EmptyState title='Nothing yet'>What it does is written here as it does it: its actions, their errors, its debug nodes.</EmptyState>;
  return (
    <ScrollArea h='100%' type='auto'>
      <Stack gap={0} p='md'>
        {[...entries].reverse().map((entry, index) => {
          let line: { node?: string; kind?: string; value?: unknown; text?: string } = {};
          try {
            line = typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data as typeof line;
          } catch {
            line = { text: String(entry.data) };
          }
          return (
            <Group key={index} gap='sm' wrap='nowrap' py={4} style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
              <Text size='xs' c='dimmed' ff='monospace' w={150} style={{ flex: '0 0 150px' }}>{formatDateTime(entry.createdAt)}</Text>
              <Badge size='sm' variant='light' color={line.kind === 'error' ? 'red' : line.kind === 'action' ? 'teal' : 'gray'} style={{ flex: '0 0 auto' }}>
                {line.kind ?? 'entry'}
              </Badge>
              <Text size='sm' fw={500} style={{ flex: '0 0 auto' }}>{line.node}</Text>
              <Text size='sm' ff='monospace' style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{line.text ?? JSON.stringify(line.value)}</Text>
            </Group>
          );
        })}
      </Stack>
    </ScrollArea>
  );
}

/**
 * Whether every change is saved: saving, saved, or why the last change could not be, with a retry
 * and reading the file again, which drops what was not saved.
 */
function SaveState({ saving, error, phone, onRetry, onReload }: { saving: boolean; error: string | null; phone: boolean; onRetry: () => void; onReload: () => void }) {
  if (error) {
    return (
      <>
        <Tooltip label={error} multiline w={300}>
          <Badge
            component='button'
            type='button'
            color='yellow'
            variant='filled'
            size='lg'
            onClick={onRetry}
            leftSection={<TablerIcon name='cloud-x' size={14} />}
            style={{ cursor: 'pointer', flex: '0 0 auto' }}
            aria-label={`Not saved: ${error}. Try again`}
          >
            {phone ? null : 'Not saved'}
          </Badge>
        </Tooltip>
        <Tooltip label='Read the file again, dropping what is not saved'>
          <ActionIcon variant='subtle' size={36} onClick={onReload} aria-label='Read the file again'>
            <TablerIcon name='reload' size={20} />
          </ActionIcon>
        </Tooltip>
      </>
    );
  }
  const label = saving ? 'Saving…' : 'Saved';
  return (
    <Tooltip label={saving ? 'Saving the latest change' : 'Every change is saved as it is made'}>
      <Box style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'white', opacity: .8, flex: '0 0 auto' }} aria-live='polite' aria-label={label}>
        {saving ? <Loader size={14} color='white' /> : <TablerIcon name='cloud-check' size={18} />}
        {!phone && <Text size='sm' c='white'>{label}</Text>}
      </Box>
    </Tooltip>
  );
}

/**
 * One automation, filling what is below the page's bar: its graph to draw and wire, its YAML, or
 * what it did, as `tab` says. Its problems, its switch and whether it is saved stand in the bar, in
 * `controls`; the leftmost `inset` px are under the page's list. The graph and the YAML are the same
 * file, and every change saves itself a moment after the last one: the graph as YAML in the editor's
 * order, as a draft while it has problems, the YAML as typed once it is YAML at all. A change not yet
 * saved is saved at once when the tab changes or the automation is left.
 */
export function AutomationEditor({ name, tab, controls, inset, onChanged }: {
  name: string;
  tab: AutomationTab;
  controls: HTMLElement | null;
  inset: number;
  onChanged: () => void;
}) {
  const phone = usePhone();
  const [detail, setDetail] = useState<AutomationDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [spec, setSpec] = useState<AutomationSpec>({ nodes: {} });
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState<'graph' | 'yaml' | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Counts the changes, so a save knows whether another came while it was on its way. */
  const edits = useRef(0);
  /** A save is on its way; one asked for meanwhile waits for it. */
  const inFlight = useRef<Promise<void> | null>(null);
  const [status, setStatus] = useState<Record<string, AutomationNodeStatus> | undefined>();
  const place = useRef<(() => [number, number]) | null>(null);

  const load = async () => {
    try {
      const next = await execCommand<AutomationDetail>(`automation-show ${shq(name)}`);
      setDetail(next);
      setSpec(next.spec && typeof next.spec === 'object' && next.spec.nodes ? next.spec : { nodes: {} });
      setText(next.text);
      setDirty(null);
      setSaveError(null);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  };
  useEffect(() => {
    setDetail(null);
    setSelection(null);
    void load();
  }, [name]);

  const editable = Boolean(detail?.writable && !detail.module);
  const read = useMemo(() => readAutomation(spec), [spec]);
  const problems = read.problems;

  // A simulation of the graph as it is: nothing real behind it, and the graph not changed meanwhile.
  const [sim, setSim] = useState<Simulation | null>(null);
  const [starting, setStarting] = useState(false);
  const [, setSimVersion] = useState(0);
  const simulate = async () => {
    if (!read.automation) return;
    setStarting(true);
    try {
      const next = await startSimulation(read.automation);
      setSelection(null);
      setSim(next);
    } catch (error) {
      failed(error);
    } finally {
      setStarting(false);
    }
  };
  useEffect(() => {
    if (!sim) return;
    // Drawn at once, and again once what it set going (a control's device reporting back) has run.
    sim.onChange = () => {
      setSimVersion((v) => v + 1);
      void sim.settled().then(() => setSimVersion((v) => v + 1));
    };
    return () => {
      sim.onChange = undefined;
      sim.stop();
    };
  }, [sim]);
  useEffect(() => setSim(null), [tab]);

  // What each node last did, while the graph is in view and the automation runs.
  useEffect(() => {
    if (tab !== 'graph' || !detail?.running || !detail.writable) {
      setStatus(undefined);
      return;
    }
    let live = true;
    const ask = () => {
      if (document.hidden) return;
      execCommand<AutomationRunStatus>(`automation-status ${shq(name)}`).then((run) => live && setStatus(run.nodes)).catch(() => {});
    };
    ask();
    const timer = setInterval(ask, STATUS_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [tab, name, detail?.running, detail?.writable]);

  const change = (next: AutomationSpec) => {
    edits.current++;
    setSpec(next);
    setDirty('graph');
  };

  /** The node asked to be removed, until the reader says yes or no. */
  const [removing, setRemoving] = useState<string | null>(null);
  /** A wire selected goes at once; a node selected is asked about first. */
  const removeSelected = () => {
    if (!editable || !selection) return;
    if (selection.kind === 'node') return setRemoving(selection.id);
    change(disconnect(spec, selection.wire));
    setSelection(null);
  };
  const remove = (id: string) => {
    change(removeNode(spec, id));
    setSelection(null);
    setRemoving(null);
  };
  useDeleteKey(tab === 'graph' && editable && !sim && selection !== null, removeSelected);

  const add = (type: string) => {
    const at = place.current?.() ?? [0, 0];
    const added = addNode(spec, type, at);
    change(added.spec);
    setSelection({ kind: 'node', id: added.id });
  };

  /** What is not saved yet, written now; a change made meanwhile stays to be saved next. */
  const save = async (): Promise<void> => {
    if (inFlight.current) await inFlight.current;
    if (!dirty) return;
    const kind = dirty;
    const at = edits.current;
    const body = kind === 'yaml' ? `--yaml ${shq(text)}` : `--json ${shq(JSON.stringify(spec))}`;
    const run = (async () => {
      setSaving(true);
      try {
        await execCommand<AutomationSetAnswer>(`automation-set ${shq(name)} ${body} --draft`);
        const next = await execCommand<AutomationDetail>(`automation-show ${shq(name)}`);
        setDetail(next);
        setSaveError(null);
        if (edits.current === at) {
          setDirty(null);
          // The other side catches up; the side being edited keeps what is on screen.
          if (kind === 'yaml') setSpec(next.spec && typeof next.spec === 'object' && next.spec.nodes ? next.spec : { nodes: {} });
          else setText(next.text);
        }
        onChanged();
      } catch (error) {
        setSaveError((error instanceof Error ? error.message : String(error)).replace(/^automation-set: /, ''));
      } finally {
        setSaving(false);
      }
    })();
    inFlight.current = run;
    await run;
    inFlight.current = null;
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  // A moment after the last change, it is saved.
  useEffect(() => {
    if (!dirty || !editable) return;
    const timer = setTimeout(() => void saveRef.current(), dirty === 'yaml' ? YAML_SAVE_MS : GRAPH_SAVE_MS);
    return () => clearTimeout(timer);
  }, [spec, text, dirty, editable]);

  // On to another tab, or away from the automation: what waits is saved at once.
  const pending = useRef(false);
  pending.current = Boolean(dirty && editable);
  useEffect(() => {
    if (pending.current) void saveRef.current();
  }, [tab]);
  useEffect(() => () => {
    if (pending.current) void saveRef.current();
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (pending.current) event.preventDefault();
    };
    globalThis.addEventListener('beforeunload', warn);
    return () => globalThis.removeEventListener('beforeunload', warn);
  }, []);

  const toggle = async (on: boolean) => {
    try {
      await execCommand(`automation-${on ? 'enable' : 'disable'} ${shq(name)}`);
      setDetail(await execCommand<AutomationDetail>(`automation-show ${shq(name)}`));
      onChanged();
    } catch (error) {
      failed(error);
    }
  };

  if (loadError) return <EmptyState title={`${name} cannot be read`}>{loadError}</EmptyState>;
  if (!detail) return <PageLoader label='Reading the automation…' />;

  const yamlProblems = dirty === 'yaml' ? [] : detail.problems;
  const shownProblems = dirty === 'graph' ? problems : tab === 'yaml' ? yamlProblems : detail.problems;
  const selectedNode = selection?.kind === 'node' ? spec.nodes[selection.id] : undefined;
  const runLog = detail.module ? `/var/logs/automations.d/${name}` : `/var/logs/automations/${name}`;
  const form = selection?.kind === 'node' && selectedNode && (
    <NodeForm
      automation={name}
      running={detail.running}
      id={selection.id}
      node={selectedNode}
      editable={editable}
      problems={problems.filter((problem) => problem.node === selection.id)}
      onChange={(changes) => change(setSettings(spec, selection.id, changes))}
      onRename={(to) => {
        const problem = nameProblem(spec, to);
        if (problem) return problem;
        change(renameNode(spec, selection.id, to));
        setSelection({ kind: 'node', id: to });
        return undefined;
      }}
      onRemove={removeSelected}
      onClose={() => setSelection(null)}
    />
  );

  const bar = (
    <>
      {detail.module && (
        <Tooltip
          label={`The ${detail.module} module's, run as the administrator; it changes with the module.${detail.writable ? ' You may turn it on and off.' : ''}`}
          multiline
          w={260}
        >
          <Badge variant='light' color='gray' size='lg' style={{ flex: '0 0 auto' }}>{detail.module}</Badge>
        </Tooltip>
      )}
      {sim && (
        <Tooltip label='Simulating: nothing real is switched or run'>
          <Badge color='grape' variant='filled' size='lg' leftSection={<TablerIcon name='flask' size={14} />} style={{ flex: '0 0 auto' }}>
            {phone ? null : 'Simulating'}
          </Badge>
        </Tooltip>
      )}
      {shownProblems.length > 0
        ? <Problems problems={shownProblems} phone={phone} onPick={tab === 'graph' ? (node) => spec.nodes[node] && setSelection({ kind: 'node', id: node }) : undefined} />
        : (
          <Badge color={detail.running ? 'teal' : 'gray'} variant='light' size='lg' style={{ flex: '0 0 auto' }}>
            {detail.running ? 'running' : detail.enabled ? 'not running' : 'off'}
          </Badge>
        )}
      <Switch
        size='sm'
        label={phone ? undefined : 'On'}
        aria-label='On'
        checked={detail.enabled}
        disabled={!detail.writable}
        onChange={(event) => void toggle(event.currentTarget.checked)}
        styles={{ label: { color: 'white' } }}
      />
      {editable && <SaveState saving={saving} error={saveError} phone={phone} onRetry={() => void save()} onReload={() => void load()} />}
    </>
  );

  // A wide screen keeps the panel: the simulation, the node selected, or the kinds to add.
  const panel = sim ? <Simulator sim={sim} onClose={() => setSim(null)} /> : form;
  const sidePanel = panel || (editable && <NodeKinds onAdd={add} />);
  const formOpen = Boolean(sidePanel) && !phone;
  const tools = tab === 'graph' && (
    <>
      <Tooltip
        label={sim ? 'Stop simulating' : read.automation ? 'Simulate: feed it inputs by hand, with nothing real switched or run' : 'Its problems must be gone to simulate it'}
        position='left'
      >
        <ActionIcon
          variant='filled'
          color={sim ? 'grape' : 'dark'}
          size={36}
          loading={starting}
          disabled={!sim && !read.automation}
          onClick={() => sim ? setSim(null) : void simulate()}
          aria-label={sim ? 'Stop simulating' : 'Simulate'}
          aria-pressed={Boolean(sim)}
        >
          <TablerIcon name='flask' size={18} />
        </ActionIcon>
      </Tooltip>
      {editable && !sim && phone && <Palette onAdd={add} phone={phone} />}
      {editable && !sim && selection?.kind === 'wire' && (
        <Tooltip label='Remove the wire' position='left'>
          <ActionIcon variant='filled' color='red' size={36} onClick={removeSelected} aria-label='Remove the wire'>
            <TablerIcon name='trash' size={18} />
          </ActionIcon>
        </Tooltip>
      )}
    </>
  );

  return (
    <Box h='100%' style={{ position: 'relative' }}>
      {controls && createPortal(bar, controls)}
      {tab === 'graph' && (
        dirty === 'yaml'
          ? (
            <Box h='100%' pl={inset}>
              <EmptyState title='The YAML is not saved yet'>{saveError ?? 'The graph is shown once it is.'}</EmptyState>
            </Box>
          )
          : (
            <>
              <Canvas
                spec={spec}
                editable={editable && !sim}
                movable={editable}
                selection={sim ? null : selection}
                onSelect={sim ? () => {} : setSelection}
                onChange={change}
                status={sim ? sim.status() : status}
                now={sim?.now}
                problems={problems}
                placeRef={place}
                seed={`automation:${name}`}
                insets={{ left: inset, right: formOpen ? FORM_WIDTH : 0 }}
                tools={tools}
              />
              {formOpen && (
                <Paper
                  radius={0}
                  shadow='md'
                  style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: FORM_WIDTH, zIndex: 2, borderLeft: '1px solid var(--mantine-color-default-border)' }}
                >
                  <ScrollArea h='100%' type='auto'>
                    <Box p='md'>{sidePanel}</Box>
                  </ScrollArea>
                </Paper>
              )}
              {phone && (
                <Drawer
                  opened={Boolean(panel)}
                  onClose={() => sim ? setSim(null) : setSelection(null)}
                  position='bottom'
                  size={sim ? '60%' : '85%'}
                  title={sim ? 'Simulation' : 'Node'}
                >
                  {panel}
                </Drawer>
              )}
            </>
          )
      )}
      <Dialog opened={removing !== null} onClose={() => setRemoving(null)} title='Remove the node?' icon='trash' pattern='danger' size='sm' floating>
        {removing && (
          <Text size='sm'>
            <b>{removing}</b> is taken out of the automation, with the wires into it and out of it.
          </Text>
        )}
        <DialogActions>
          <Button variant='default' onClick={() => setRemoving(null)}>Cancel</Button>
          <Button color='red' onClick={() => removing && remove(removing)} data-autofocus>Remove the node</Button>
        </DialogActions>
      </Dialog>
      {tab === 'yaml' && (
        <Box h='100%' p='sm' pl={inset ? inset + 12 : undefined}>
          {dirty === 'graph' ? <EmptyState title='The graph is not saved yet'>{saveError ?? 'Its YAML is shown once it is.'}</EmptyState> : (
            <CodeMirror
              value={text}
              language='yaml'
              readOnly={!editable}
              onChange={(next) => {
                edits.current++;
                setText(next);
                setDirty(next === detail.text ? null : 'yaml');
              }}
            />
          )}
        </Box>
      )}
      {tab === 'runs' && (
        <Box h='100%' pl={inset}>
          {detail.writable ? <Runs path={runLog} /> : <EmptyState title='Not yours to read'>Only its owner and the administrator read what an automation did.</EmptyState>}
        </Box>
      )}
    </Box>
  );
}
