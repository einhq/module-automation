import { EmptyState, ListFilterInput, PageBar, TablerIcon } from '@ein/ui/components';
import { usePhone, usePolledCommand } from '@ein/ui/hooks';
import { matchesText, shq } from '@ein/ui/lib';
import { execCommand, notify } from '@ein/ui/signals';
import { ActionIcon, Box, Button, Group, Menu, Modal, Paper, ScrollArea, Select, Stack, Text, TextInput, Tooltip, UnstyledButton } from '@mantine/core';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { AutomationSetAnswer, AutomationSummary } from '@automation/api';
import { EXAMPLES } from '../../lib/automations/examples.ts';
import { AutomationEditor } from '../automation/Editor.tsx';

export const handle = { fullBleed: true, title: 'Automations', pattern: 'mixed' };

/** The bar's round buttons: finger-sized on a phone, as the app header's are. */
const BAR_BUTTON = { size: 36, icon: 22 };

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

/**
 * The automations, beside the one open: its graph, its YAML and what it did. `/automations/<name>`
 * opens one, a module's as `<module>%2F<name>`; a phone has the list in a menu in the bar.
 */
export default function AutomationsPage() {
  const params = useParams();
  const name = params.name ? decodeURIComponent(params.name) : undefined;
  const navigate = useNavigate();
  const phone = usePhone();
  const { data, error, refetch } = usePolledCommand<AutomationSummary[]>('automations');
  const [filter, setFilter] = useState('');
  const [making, setMaking] = useState(false);
  const list = data ?? [];
  const open = (next: string) => navigate(`/automations/${encodeURIComponent(next)}`);

  const controls = (
    <>
      <Tooltip label='New automation'>
        <ActionIcon variant='subtle' size={phone ? BAR_BUTTON.size : undefined} onClick={() => setMaking(true)} aria-label='New automation'>
          <TablerIcon name='plus' size={phone ? BAR_BUTTON.icon : 17} />
        </ActionIcon>
      </Tooltip>
      {phone && (
        <Menu shadow='md' width={320} position='bottom-end'>
          <Menu.Target>
            <ActionIcon variant='subtle' size={BAR_BUTTON.size} aria-label='Automations'>
              <TablerIcon name='list' size={BAR_BUTTON.icon} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <ScrollArea.Autosize mah={420} type='auto'>
              <AutomationRows list={list} active={name} filter='' onPick={open} />
            </ScrollArea.Autosize>
          </Menu.Dropdown>
        </Menu>
      )}
    </>
  );

  return (
    <Paper
      radius={0}
      bg='var(--mrx-surface-base)'
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: 'calc(100dvh - var(--app-shell-header-offset, 48px))',
        // A phone's keyboard shrinks the viewport; a floor there would scroll the top bar away.
        minHeight: phone ? undefined : 420,
        overflow: 'hidden',
      }}
    >
      <PageBar title={name ?? 'Automations'} pattern='mixed' band controls={controls} />
      <Box style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Box w={340} h='100%' p='md' pr={0} style={{ flex: '0 0 340px', overflow: 'hidden' }} visibleFrom='sm'>
          <Paper h='100%' p='sm' radius='md' withBorder>
            <Stack gap='xs' h='100%'>
              <ListFilterInput value={filter} onChange={setFilter} what='automations' size='sm' />
              <ScrollArea type='auto' scrollbars='y' offsetScrollbars='y' style={{ flex: 1, minHeight: 0 }}>
                {error ? <Text size='sm' c='red' p='sm'>{error.message}</Text> : <AutomationRows list={list} active={name} filter={filter} onPick={open} />}
              </ScrollArea>
            </Stack>
          </Paper>
        </Box>
        <Box style={{ flex: 1, minWidth: 0, minHeight: 0 }} p={phone ? 0 : 'md'}>
          <Paper h='100%' radius={phone ? 0 : 'md'} withBorder={!phone} style={{ overflow: 'hidden' }}>
            {name ? <AutomationEditor key={name} name={name} onChanged={() => void refetch()} /> : (
              <EmptyState
                title='Automations'
                actions={<Button leftSection={<TablerIcon name='plus' size={16} />} onClick={() => setMaking(true)}>New automation</Button>}
              >
                Nodes wired together that switch things, run command lines and keep time when a reading, a press or the clock says so. Pick one, or make one.
              </EmptyState>
            )}
          </Paper>
        </Box>
      </Box>
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
