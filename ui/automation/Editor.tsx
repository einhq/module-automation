import { CodeMirror, EmptyState, PageLoader, TablerIcon } from '@ein/ui/components';
import { useLogFollow, usePhone } from '@ein/ui/hooks';
import { shq } from '@ein/ui/lib';
import { execCommand, notify } from '@ein/ui/signals';
import { ActionIcon, Badge, Box, Button, Drawer, Group, Menu, Paper, Popover, ScrollArea, Stack, Switch, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AutomationDetail, AutomationNodeStatus, AutomationProblem, AutomationRunStatus, AutomationSetAnswer, AutomationSpec } from '../../lib/api.ts';
import { KINDS } from '../../lib/automations/catalog.ts';
import { readAutomation } from '../../lib/automations/graph.ts';
import { Canvas, type Selection, useDeleteKey } from './Canvas.tsx';
import { addNode, disconnect, removeNode, setSettings } from './graph-edit.ts';
import { NodeForm } from './NodeForm.tsx';

export type AutomationTab = 'graph' | 'yaml' | 'runs';

/** How often a running automation's nodes are asked what they did, while its graph is open. */
const STATUS_MS = 3000;

const GROUPS = [
  { group: 'input', label: 'Inputs' },
  { group: 'logic', label: 'Logic' },
  { group: 'value', label: 'Values' },
  { group: 'time', label: 'Time' },
  { group: 'action', label: 'Actions' },
] as const;

const failed = (error: unknown) => notify({ message: error instanceof Error ? error.message : String(error), color: 'red' });

/** How wide the panel of the node tapped is, over the canvas's right edge. */
const FORM_WIDTH = 320;

/** The kinds of node to add, by group, in a menu from a button on the canvas. */
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
                  leftSection={<TablerIcon name={kind.icon} size={16} />}
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
              <Text size='xs' c='dimmed' ff='monospace' w={150} style={{ flex: '0 0 150px' }}>{new Date(entry.createdAt).toLocaleString()}</Text>
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
 * One automation, filling what is below the page's bar: its graph to draw and wire, its YAML, or
 * what it did, as `tab` says. Its problems, its switch and Save stand in the bar, in `controls`; the
 * leftmost `inset` px are under the page's list. The graph and the YAML are the same file; each tab
 * saves its own changes, the graph as YAML in the editor's order, the YAML as typed, and while one
 * has changes not saved the other shows the file as it was.
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
  const [status, setStatus] = useState<Record<string, AutomationNodeStatus> | undefined>();
  const place = useRef<(() => [number, number]) | null>(null);

  const load = async () => {
    try {
      const next = await execCommand<AutomationDetail>(`automation-show ${shq(name)}`);
      setDetail(next);
      setSpec(next.spec && typeof next.spec === 'object' && next.spec.nodes ? next.spec : { nodes: {} });
      setText(next.text);
      setDirty(null);
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
  const problems = useMemo(() => readAutomation(spec).problems, [spec]);

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
    setSpec(next);
    setDirty('graph');
  };

  const removeSelected = () => {
    if (!editable || !selection) return;
    change(selection.kind === 'node' ? removeNode(spec, selection.id) : disconnect(spec, selection.wire));
    setSelection(null);
  };
  useDeleteKey(tab === 'graph' && editable && selection !== null, removeSelected);

  const add = (type: string) => {
    const at = place.current?.() ?? [0, 0];
    const added = addNode(spec, type, at);
    change(added.spec);
    setSelection({ kind: 'node', id: added.id });
  };

  const save = async (draft = false) => {
    setSaving(true);
    try {
      const body = dirty === 'yaml' ? `--yaml ${shq(text)}` : `--json ${shq(JSON.stringify(spec))}`;
      const answer = await execCommand<AutomationSetAnswer>(`automation-set ${shq(name)} ${body}${draft ? ' --draft' : ''}`);
      notify({
        message: answer.problems.length ? `${name} saved; it does not run until its problems are gone` : `${name} saved`,
        color: answer.problems.length ? 'yellow' : 'green',
      });
      await load();
      onChanged();
    } catch (error) {
      failed(error);
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (on: boolean) => {
    try {
      await execCommand(`automation-${on ? 'enable' : 'disable'} ${shq(name)}`);
      await load();
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
      id={selection.id}
      node={selectedNode}
      editable={editable}
      problems={problems.filter((problem) => problem.node === selection.id)}
      onChange={(changes) => change(setSettings(spec, selection.id, changes))}
      onRemove={removeSelected}
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
      {dirty && (
        <Tooltip label='Read the file again'>
          <ActionIcon variant='subtle' size={36} onClick={() => void load()} aria-label='Read the file again'>
            <TablerIcon name='reload' size={20} />
          </ActionIcon>
        </Tooltip>
      )}
      {editable && (
        <Button size='xs' loading={saving} disabled={!dirty} onClick={() => void save(dirty === 'graph' && problems.length > 0)} style={{ flex: '0 0 auto' }}>
          {dirty === 'graph' && problems.length > 0 ? 'Save as draft' : 'Save'}
        </Button>
      )}
    </>
  );

  const formOpen = Boolean(form) && !phone;
  const tools = tab === 'graph' && editable && (
    <>
      <Palette onAdd={add} phone={phone} />
      {selection?.kind === 'wire' && (
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
              <EmptyState title='The YAML has changes not saved'>Save them, or read the file again, to see the graph.</EmptyState>
            </Box>
          )
          : (
            <>
              <Canvas
                spec={spec}
                editable={editable}
                selection={selection}
                onSelect={setSelection}
                onChange={change}
                status={status}
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
                    <Box p='md'>{form}</Box>
                  </ScrollArea>
                </Paper>
              )}
              {phone && (
                <Drawer opened={Boolean(form)} onClose={() => setSelection(null)} position='bottom' size='85%' title='Node'>
                  {form}
                </Drawer>
              )}
            </>
          )
      )}
      {tab === 'yaml' && (
        <Box h='100%' p='sm' pl={inset ? inset + 12 : undefined}>
          {dirty === 'graph' ? <EmptyState title='The graph has changes not saved'>Save them to see them here as YAML, or read the file again.</EmptyState> : (
            <CodeMirror
              value={text}
              language='yaml'
              readOnly={!editable}
              onChange={(next) => {
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
