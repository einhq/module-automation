import { CodeMirror, EmptyState, PageLoader, TablerIcon } from '@ein/ui/components';
import { useLogFollow, usePhone } from '@ein/ui/hooks';
import { shq } from '@ein/ui/lib';
import { execCommand, notify } from '@ein/ui/signals';
import { Alert, Badge, Box, Button, Drawer, Group, Menu, ScrollArea, SegmentedControl, Stack, Switch, Text, Tooltip } from '@mantine/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AutomationDetail, AutomationNodeStatus, AutomationRunStatus, AutomationSetAnswer, AutomationSpec } from '../../lib/api.ts';
import { KINDS } from '../../lib/automations/catalog.ts';
import { readAutomation } from '../../lib/automations/graph.ts';
import { Canvas, type Selection, useDeleteKey } from './Canvas.tsx';
import { addNode, disconnect, removeNode, setSettings } from './graph-edit.ts';
import { NodeForm } from './NodeForm.tsx';

type Tab = 'graph' | 'yaml' | 'runs';

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

/** The kinds of node to add, by group: a list beside the canvas, or a menu on a phone. */
function Palette({ onAdd, menu }: { onAdd: (type: string) => void; menu?: boolean }) {
  const kinds = Object.values(KINDS);
  if (menu) {
    return (
      <Menu shadow='md' width={260} position='bottom-start'>
        <Menu.Target>
          <Button size='xs' variant='default' leftSection={<TablerIcon name='plus' size={14} />}>Add</Button>
        </Menu.Target>
        <Menu.Dropdown style={{ maxHeight: '70dvh', overflowY: 'auto' }}>
          {GROUPS.map(({ group, label }) => (
            <Box key={group}>
              <Menu.Label>{label}</Menu.Label>
              {kinds.filter((kind) => kind.group === group).map((kind) => (
                <Menu.Item
                  key={kind.type}
                  leftSection={<TablerIcon name={kind.icon} size={16} />}
                  onClick={() => onAdd(kind.type)}
                >
                  {kind.label}
                </Menu.Item>
              ))}
            </Box>
          ))}
        </Menu.Dropdown>
      </Menu>
    );
  }
  return (
    <ScrollArea w={190} h='100%' type='auto' style={{ flex: '0 0 190px', borderRight: '1px solid var(--mantine-color-default-border)' }}>
      <Stack gap={2} p='xs'>
        {GROUPS.map(({ group, label }) => (
          <Box key={group} mb={6}>
            <Text size='xs' c='dimmed' fw={600} tt='uppercase' px={6} py={4}>{label}</Text>
            {kinds.filter((kind) => kind.group === group).map((kind) => (
              <Tooltip key={kind.type} label={kind.description} position='right' openDelay={400} multiline w={240}>
                <Button
                  variant='subtle'
                  color='gray'
                  size='compact-sm'
                  fullWidth
                  justify='flex-start'
                  leftSection={<TablerIcon name={kind.icon} size={16} />}
                  onClick={() => onAdd(kind.type)}
                >
                  {kind.label}
                </Button>
              </Tooltip>
            ))}
          </Box>
        ))}
      </Stack>
    </ScrollArea>
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
 * One automation: its graph to draw and wire, its YAML, and what it did. The graph and the YAML
 * are the same file; each tab saves its own changes, the graph as YAML in the editor's order, the
 * YAML as typed, and while one has changes not saved the other shows the file as it was.
 */
export function AutomationEditor({ name, onChanged }: { name: string; onChanged: () => void }) {
  const phone = usePhone();
  const [detail, setDetail] = useState<AutomationDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [spec, setSpec] = useState<AutomationSpec>({ nodes: {} });
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState<'graph' | 'yaml' | null>(null);
  const [tab, setTab] = useState<Tab>('graph');
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

  return (
    <Stack gap={0} h='100%'>
      <Group gap='xs' px='md' py={8} justify='space-between' wrap='wrap' style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
        <Group gap='xs' wrap='nowrap'>
          <SegmentedControl
            size='xs'
            value={tab}
            onChange={(next) => setTab(next as Tab)}
            data={[{ value: 'graph', label: 'Graph' }, { value: 'yaml', label: 'YAML' }, { value: 'runs', label: 'Runs' }]}
          />
          {tab === 'graph' && editable && phone && <Palette onAdd={add} menu />}
          {tab === 'graph' && editable && selection?.kind === 'wire' && (
            <Button size='xs' variant='light' color='red' leftSection={<TablerIcon name='trash' size={14} />} onClick={removeSelected}>Remove the wire</Button>
          )}
        </Group>
        <Group gap='xs' wrap='nowrap'>
          {shownProblems.length > 0 && <Badge color='red' variant='light'>{shownProblems.length} {shownProblems.length === 1 ? 'problem' : 'problems'}</Badge>}
          {!shownProblems.length && (
            <Badge color={detail.running ? 'teal' : 'gray'} variant='light'>{detail.running ? 'running' : detail.enabled ? 'not running' : 'off'}</Badge>
          )}
          <Switch
            size='sm'
            label='On'
            checked={detail.enabled}
            disabled={!detail.writable}
            onChange={(event) => void toggle(event.currentTarget.checked)}
          />
          {editable && (
            <Button size='xs' loading={saving} disabled={!dirty} onClick={() => void save(dirty === 'graph' && problems.length > 0)}>
              {dirty === 'graph' && problems.length > 0 ? 'Save as draft' : 'Save'}
            </Button>
          )}
        </Group>
      </Group>
      {detail.module && (
        <Alert color='gray' variant='light' radius={0} py={6}>
          The {detail.module} module's, run as the administrator; it changes with the module. {detail.writable ? 'You may turn it on and off.' : ''}
        </Alert>
      )}
      {shownProblems.length > 0 && tab !== 'runs' && (
        <Alert color='red' variant='light' radius={0} py={6}>
          <Stack gap={2}>
            {shownProblems.slice(0, 4).map((problem, index) => <Text key={index} size='sm'>{problem.node ? `${problem.node}: ` : ''}{problem.message}</Text>)}
          </Stack>
        </Alert>
      )}
      <Box style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {tab === 'graph' && (
          <>
            {editable && !phone && <Palette onAdd={add} />}
            <Box style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
              {dirty === 'yaml' ? <EmptyState title='The YAML has changes not saved'>Save them, or read the file again, to see the graph.</EmptyState> : (
                <Canvas
                  spec={spec}
                  editable={editable}
                  selection={selection}
                  onSelect={setSelection}
                  onChange={change}
                  status={status}
                  problems={problems}
                  placeRef={place}
                />
              )}
            </Box>
            {form && !phone && (
              <ScrollArea w={340} type='auto' style={{ flex: '0 0 340px', borderLeft: '1px solid var(--mantine-color-default-border)' }}>
                <Box p='md'>{form}</Box>
              </ScrollArea>
            )}
            {phone && (
              <Drawer opened={Boolean(form)} onClose={() => setSelection(null)} position='bottom' size='85%' title='Node'>
                {form}
              </Drawer>
            )}
          </>
        )}
        {tab === 'yaml' && (
          <Box style={{ flex: 1, minWidth: 0 }} p='sm'>
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
          <Box style={{ flex: 1, minWidth: 0 }}>
            {detail.writable ? <Runs path={runLog} /> : <EmptyState title='Not yours to read'>Only its owner and the administrator read what an automation did.</EmptyState>}
          </Box>
        )}
      </Box>
      {dirty && (
        <Group justify='flex-end' px='md' py={6} style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
          <Button size='xs' variant='subtle' color='gray' onClick={() => void load()}>Read the file again</Button>
        </Group>
      )}
    </Stack>
  );
}
