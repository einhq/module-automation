import { Markdown, TablerIcon } from '@ein/ui/components';
import { agoText, readingText, shq } from '@ein/ui/lib';
import { execCommand, loadUserConfig, notify, userConfigFlag } from '@ein/ui/signals';
import { useSignals } from '@preact/signals-react/runtime';
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Collapse,
  Group,
  Loader,
  MultiSelect,
  NumberInput,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { type ReactNode, useEffect, useState } from 'react';
import type { DeviceInfo, DeviceSummary, EndpointSummary } from '@ein/api';
import type { AutomationNodeSpec, AutomationProblem } from '../../lib/api.ts';
import { KINDS, type KindSpec, type SettingSpec } from '../../lib/automations/catalog.ts';

type NodeFormProps = {
  /** The automation's name, for pressing a button node. */
  automation: string;
  /** Whether the automation runs, which a button node needs to be pressed. */
  running: boolean;
  id: string;
  node: AutomationNodeSpec;
  editable: boolean;
  problems: AutomationProblem[];
  onChange: (changes: Record<string, unknown>) => void;
  /** Name the node `to`; answers why it cannot be, or undefined once it is. */
  onRename: (to: string) => string | undefined;
  onRemove: () => void;
};

/** Whether the docs at the foot of a node's panel are open, the reader's setting. */
const DOCS_SETTING = 'CFG_USER_AUTOMATION_NODE_DOCS';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** A value typed into a field: a number, true or false as they are, any other text as text. */
const typed = (text: string): unknown => {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true';
  return trimmed !== '' && Number.isFinite(Number(trimmed)) ? Number(trimmed) : text;
};

const shown = (value: unknown): string => value === undefined || value === null ? '' : String(value);

/** The devices, fetched once while a form is open. */
let devicesOnce: Promise<DeviceSummary[]> | null = null;
const devices = () =>
  devicesOnce ??= execCommand<DeviceSummary[]>('devices').catch((error) => {
    devicesOnce = null;
    throw error;
  });

/** A field's title where no input draws one, with the red star a required input's label has. */
function FieldTitle({ required, children }: { required: boolean; children: ReactNode }) {
  return (
    <Text size='sm' fw={500}>
      {children}
      {required && <Text span c='var(--mantine-color-error)' ml={4} aria-hidden='true'>*</Text>}
    </Text>
  );
}

/**
 * A device, then one of its endpoints from a list beneath it, each with its latest value: those a
 * control node may write when `controls`. A device picked takes its first endpoint at once, so the
 * node never names a device without one; a node left like that takes it when it is opened.
 */
function EndpointPicker(
  { value, controls, required, disabled, onChange }: { value: string; controls: boolean; required: boolean; disabled: boolean; onChange: (value: string) => void },
) {
  const [device, endpoint] = value.split('/');
  const [list, setList] = useState<DeviceSummary[]>([]);
  const [loaded, setLoaded] = useState<{ device: string; endpoints: EndpointSummary[] } | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const offeredOf = (endpoints: EndpointSummary[]) => endpoints.filter((each) => !each.retired && (controls ? each.type === 'control' : each.type !== 'track'));
  const endpointsOf = (name: string) => execCommand<DeviceInfo>(`device-show ${shq(name)}`).then((info) => info.endpointList).catch(() => [] as EndpointSummary[]);
  useEffect(() => {
    devices().then(setList).catch(() => setList([]));
  }, []);
  useEffect(() => {
    if (!device) return setLoaded(null);
    let live = true;
    endpointsOf(device).then((endpoints) => {
      if (!live) return;
      setLoaded({ device, endpoints });
      const first = offeredOf(endpoints)[0];
      if (!endpoint && first && !disabled) onChange(`${device}/${first.name}`);
    });
    return () => {
      live = false;
    };
  }, [device]);
  const pick = async (next: string | null) => {
    if (!next) return onChange('');
    setPicking(next);
    const endpoints = await endpointsOf(next);
    setPicking(null);
    setLoaded({ device: next, endpoints });
    const first = offeredOf(endpoints)[0];
    onChange(first ? `${next}/${first.name}` : `${next}/`);
  };
  const offered = loaded?.device === device ? offeredOf(loaded.endpoints) : [];
  return (
    <Stack gap={6}>
      <Select
        label='Device'
        withAsterisk={required}
        searchable
        disabled={disabled || picking !== null}
        data={list.map((each) => ({ value: each.name, label: each.label === each.name ? each.name : `${each.label} (${each.name})` }))}
        value={picking ?? (device || null)}
        onChange={(next) => void pick(next)}
      />
      {device && (
        <Stack gap={2}>
          <FieldTitle required={required}>{controls ? 'Control' : 'Endpoint'}</FieldTitle>
          {loaded?.device !== device || picking
            ? <Loader size='sm' />
            : !offered.length
            ? <Text size='sm' c='dimmed'>{controls ? 'It has no control to switch.' : 'It has no endpoint to read.'}</Text>
            : (
              <ScrollArea.Autosize mah={280} type='auto' offsetScrollbars='y'>
                <Stack gap={2} role='radiogroup' aria-label={controls ? 'Control' : 'Endpoint'}>
                  {offered.map((each) => {
                    const chosen = each.name === endpoint;
                    return (
                      <UnstyledButton
                        key={each.name}
                        role='radio'
                        aria-checked={chosen}
                        disabled={disabled}
                        className='mrx-hover-row'
                        onClick={() => onChange(`${device}/${each.name}`)}
                        style={{
                          padding: '8px 12px',
                          borderRadius: 'var(--mantine-radius-sm)',
                          border: `1px solid ${chosen ? 'var(--mantine-primary-color-filled)' : 'var(--mantine-color-default-border)'}`,
                          background: chosen ? 'var(--mantine-primary-color-light)' : undefined,
                        }}
                      >
                        <Group gap={8} wrap='nowrap' justify='space-between'>
                          <Box style={{ minWidth: 0 }}>
                            <Text size='sm' fw={chosen ? 600 : 400} truncate>{each.label && each.label !== each.name ? each.label : each.name}</Text>
                            {each.label && each.label !== each.name && <Text size='xs' c='dimmed' truncate>{each.name}</Text>}
                          </Box>
                          <Box style={{ textAlign: 'right', flex: '0 0 auto' }}>
                            <Text size='sm' ff='monospace'>{readingText(each.last?.value, each.unit)}</Text>
                            {each.last && <Text size='xs' c='dimmed'>{agoText(each.last.at)}</Text>}
                          </Box>
                        </Group>
                      </UnstyledButton>
                    );
                  })}
                </Stack>
              </ScrollArea.Autosize>
            )}
        </Stack>
      )}
    </Stack>
  );
}

/** A switch's cases: each a name, one test and its value. */
function CasesEditor(
  { value, required, disabled, onChange }: { value: unknown; required: boolean; disabled: boolean; onChange: (cases: Record<string, Record<string, unknown>>) => void },
) {
  const cases = value && typeof value === 'object' ? Object.entries(value as Record<string, Record<string, unknown>>) : [];
  const put = (rows: [string, Record<string, unknown>][]) => onChange(Object.fromEntries(rows));
  return (
    <Stack gap='xs'>
      <FieldTitle required={required}>Cases</FieldTitle>
      {cases.map(([name, test], index) => {
        const [key, given] = Object.entries(test ?? {})[0] ?? ['is', ''];
        return (
          <Group key={index} gap='xs' wrap='nowrap' align='flex-end'>
            <TextInput
              aria-label='Case'
              value={name}
              disabled={disabled}
              onChange={(event) => put(cases.map((row, at) => at === index ? [event.currentTarget.value, row[1]] : row))}
              style={{ flex: 1 }}
            />
            <Select
              aria-label='Test'
              data={['is', 'not', 'above', 'below']}
              value={key}
              disabled={disabled}
              onChange={(next) => put(cases.map((row, at) => at === index ? [row[0], { [next ?? 'is']: given }] : row))}
              w={90}
            />
            <TextInput
              aria-label='Value'
              value={shown(given)}
              disabled={disabled}
              onChange={(event) => put(cases.map((row, at) => at === index ? [row[0], { [key]: typed(event.currentTarget.value) ?? '' }] : row))}
              style={{ flex: 1 }}
            />
            <ActionIcon variant='subtle' color='gray' disabled={disabled} onClick={() => put(cases.filter((_, at) => at !== index))} aria-label='Remove the case'>
              <TablerIcon name='x' size={16} />
            </ActionIcon>
          </Group>
        );
      })}
      <Button
        variant='default'
        size='xs'
        disabled={disabled}
        leftSection={<TablerIcon name='plus' size={14} />}
        onClick={() => put([...cases, [`case-${cases.length + 1}`, { is: '' }]])}
      >
        Add a case
      </Button>
    </Stack>
  );
}

function SettingField(
  { setting, value, controls, disabled, onChange }: { setting: SettingSpec; value: unknown; controls: boolean; disabled: boolean; onChange: (value: unknown) => void },
) {
  const label = setting.label;
  const required = setting.required === true;
  switch (setting.type) {
    case 'endpoint':
      return <EndpointPicker value={shown(value)} controls={controls} required={required} disabled={disabled} onChange={onChange} />;
    case 'device':
      return <DevicePicker value={shown(value)} label={label} required={required} disabled={disabled} onChange={onChange} />;
    case 'number':
      return (
        <NumberInput
          label={label}
          withAsterisk={required}
          description={setting.help}
          value={typeof value === 'number' ? value : ''}
          disabled={disabled}
          onChange={(next) => onChange(typeof next === 'number' ? next : undefined)}
        />
      );
    case 'flag':
      return (
        <Switch
          label={setting.label}
          description={setting.help}
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked || undefined)}
        />
      );
    case 'choice':
      return (
        <Select
          label={label}
          withAsterisk={required}
          description={setting.help}
          data={[...setting.choices ?? []]}
          value={shown(value) || null}
          disabled={disabled}
          onChange={(next) => onChange(next ?? undefined)}
        />
      );
    case 'days':
      return (
        <MultiSelect
          label={label}
          withAsterisk={required}
          description={setting.help}
          data={DAYS}
          value={Array.isArray(value)
            ? value.map(String)
            : typeof value === 'string'
            ? value === 'weekdays' ? DAYS.slice(0, 5) : value === 'weekends' ? DAYS.slice(5) : value.split(/[\s,]+/)
            : []}
          disabled={disabled}
          onChange={(next) => onChange(next.length ? next : undefined)}
        />
      );
    case 'cases':
      return <CasesEditor value={value} required={required} disabled={disabled} onChange={onChange} />;
    case 'value':
      return (
        <TextInput
          label={label}
          withAsterisk={required}
          description={setting.help}
          value={shown(value)}
          disabled={disabled}
          onChange={(event) => onChange(typed(event.currentTarget.value))}
        />
      );
    default:
      return (
        <TextInput
          label={label}
          withAsterisk={required}
          description={setting.help}
          value={shown(value)}
          disabled={disabled}
          ff={setting.type === 'expression' || setting.type === 'line' ? 'monospace' : undefined}
          onChange={(event) => onChange(event.currentTarget.value || undefined)}
        />
      );
  }
}

function DevicePicker(
  { value, label, required, disabled, onChange }: { value: string; label: string; required: boolean; disabled: boolean; onChange: (value: string | undefined) => void },
) {
  const [list, setList] = useState<DeviceSummary[]>([]);
  useEffect(() => {
    devices().then(setList).catch(() => setList([]));
  }, []);
  return (
    <Select
      label={label}
      withAsterisk={required}
      searchable
      disabled={disabled}
      data={list.map((each) => ({ value: each.name, label: each.label === each.name ? each.name : `${each.label} (${each.name})` }))}
      value={value || null}
      onChange={(next) => onChange(next ?? undefined)}
    />
  );
}

/** The node's id, typed and taken when the field is left or Enter is pressed, or put back with Escape. */
function NameField({ id, disabled, onRename }: { id: string; disabled: boolean; onRename: (to: string) => string | undefined }) {
  const [text, setText] = useState(id);
  const [problem, setProblem] = useState<string | undefined>();
  useEffect(() => {
    setText(id);
    setProblem(undefined);
  }, [id]);
  const commit = () => {
    const to = text.trim();
    if (to === id) return setProblem(undefined);
    setProblem(onRename(to));
  };
  return (
    <TextInput
      label='Name'
      withAsterisk
      description='What wires and math name it by, and its key in the YAML'
      value={text}
      error={problem}
      disabled={disabled}
      ff='monospace'
      onChange={(event) => setText(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
        if (event.key === 'Escape') {
          setText(id);
          setProblem(undefined);
        }
      }}
    />
  );
}

/** Press a button node of the running automation, as `automation-trigger` does. */
function PressButton({ automation, id, running }: { automation: string; id: string; running: boolean }) {
  const [busy, setBusy] = useState(false);
  const press = async () => {
    setBusy(true);
    try {
      await execCommand(`automation-trigger ${shq(automation)} ${shq(id)}`);
    } catch (error) {
      notify({ message: error instanceof Error ? error.message : String(error), color: 'red' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Tooltip label='Only a running automation is pressed' disabled={running}>
      <Button variant='light' leftSection={<TablerIcon name='player-play' size={16} />} loading={busy} disabled={!running} onClick={() => void press()}>
        Press
      </Button>
    </Tooltip>
  );
}

/** What a kind does and what each of its settings means, under a heading that folds, as the reader last left it. */
function KindDocs({ kind }: { kind: KindSpec }) {
  useSignals();
  const open = userConfigFlag(DOCS_SETTING, true);
  const toggle = async () => {
    try {
      await execCommand(`config set ${DOCS_SETTING} ${!open}`);
      await loadUserConfig();
    } catch (error) {
      notify({ message: error instanceof Error ? error.message : String(error), color: 'red' });
    }
  };
  const outputs = kind.outputs.length === 0
    ? 'Nothing: it is where a line ends.'
    : kind.boolean
    ? `True or false, on out and on the output of that name; only when it changes${
      kind.settings.some((each) => each.name === 'every') ? ', unless Send every result is on' : ''
    }.`
    : kind.type === 'switch'
    ? 'The value, on the output of the first case it passes, or on else.'
    : 'On out.';
  return (
    <Box style={{ borderTop: '1px solid var(--mantine-color-default-border)' }} pt='xs'>
      <UnstyledButton onClick={() => void toggle()} aria-expanded={open} style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
        <TablerIcon name={open ? 'chevron-down' : 'chevron-right'} size={16} />
        <Text size='sm' fw={600}>About {kind.label.toLowerCase()} nodes</Text>
      </UnstyledButton>
      <Collapse expanded={open} transitionDuration={150}>
        <Stack gap='xs' pt='xs'>
          <Markdown content={kind.about} />
          <Text size='sm'>
            <Text span fw={600}>Sends:</Text>
            {outputs}
          </Text>
          {kind.input === false && <Text size='sm' c='dimmed'>Nothing is wired into it: it starts things.</Text>}
          {kind.settings.length > 0 && (
            <Stack gap={4}>
              <Text size='sm' fw={600}>Settings</Text>
              {kind.settings.map((setting) => (
                <Text key={setting.name} size='sm'>
                  <Text span fw={500}>{setting.label}</Text>
                  {setting.required && <Text span c='var(--mantine-color-error)' ml={2}>*</Text>} <Text span ff='monospace' size='xs' c='dimmed'>{setting.name}</Text>
                  {setting.help ? ` — ${setting.help}` : ''}
                </Text>
              ))}
            </Stack>
          )}
        </Stack>
      </Collapse>
    </Box>
  );
}

/** A node's settings, as its kind in the catalog has them, each change made at once, and its docs below them. */
export function NodeForm({ automation, running, id, node, editable, problems, onChange, onRename, onRemove }: NodeFormProps) {
  const kind = KINDS[node.type];
  const color = kind?.color ?? 'gray';
  return (
    <Stack gap='sm'>
      <Group gap='sm' wrap='nowrap'>
        <ThemeIcon color={color} variant='light' size={36} radius='md'>
          <TablerIcon name={kind?.icon ?? 'help'} size={20} />
        </ThemeIcon>
        <Stack gap={0} style={{ minWidth: 0 }}>
          <Text fw={600} truncate>{kind?.label ?? node.type}</Text>
          <Text size='xs' c='dimmed'>{kind?.description}</Text>
        </Stack>
      </Group>
      {problems.map((problem, index) => <Alert key={index} color='red' variant='light' p='xs'>{problem.message}</Alert>)}
      <NameField id={id} disabled={!editable} onRename={onRename} />
      <TextInput
        label='Label'
        description='Shown on its card in place of its name'
        value={shown(node.label)}
        disabled={!editable}
        onChange={(event) => onChange({ label: event.currentTarget.value || undefined })}
      />
      {kind?.settings.map((setting) => (
        <SettingField
          key={setting.name}
          setting={setting}
          value={node[setting.name]}
          controls={node.type === 'control'}
          disabled={!editable}
          onChange={(value) => onChange({ [setting.name]: value })}
        />
      ))}
      {node.type === 'button' && <PressButton automation={automation} id={id} running={running} />}
      {editable && (
        <Button variant='light' color='red' leftSection={<TablerIcon name='trash' size={16} />} onClick={onRemove}>
          Remove the node
        </Button>
      )}
      {kind && <KindDocs kind={kind} />}
    </Stack>
  );
}
