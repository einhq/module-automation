import { TablerIcon } from '@ein/ui/components';
import { matchesText } from '@ein/ui/lib';
import { Box, Stack, Text, TextInput, ThemeIcon, UnstyledButton } from '@mantine/core';
import { useState } from 'react';
import { KINDS } from '../../lib/automations/catalog.ts';

export const GROUPS = [
  { group: 'input', label: 'Inputs' },
  { group: 'logic', label: 'Logic' },
  { group: 'value', label: 'Values' },
  { group: 'time', label: 'Time' },
  { group: 'action', label: 'Actions' },
] as const;

/**
 * The kinds of node, by group, each with its colour, its icon and what it does, those whose name or
 * description holds the filter: the panel beside the canvas while no node is selected. A click adds
 * one (`onAdd`).
 */
export function NodeKinds({ onAdd }: { onAdd: (type: string) => void }) {
  const [filter, setFilter] = useState('');
  const kinds = Object.values(KINDS).filter((kind) => matchesText([kind.label, kind.description, kind.type], filter));
  return (
    <Stack gap='sm'>
      <Box>
        <Text fw={600}>Add a node</Text>
        <Text size='xs' c='dimmed'>It lands in the middle of what is in view. Select a card to set it up.</Text>
      </Box>
      <TextInput
        size='sm'
        placeholder='Filter the kinds'
        leftSection={<TablerIcon name='search' size={16} />}
        value={filter}
        onChange={(event) => setFilter(event.currentTarget.value)}
        aria-label='Filter the kinds of node'
      />
      {GROUPS.map(({ group, label }) => {
        const shown = kinds.filter((kind) => kind.group === group);
        if (!shown.length) return null;
        return (
          <Stack key={group} gap={2}>
            <Text size='xs' c='dimmed' fw={600} tt='uppercase' px={4}>{label}</Text>
            {shown.map((kind) => (
              <UnstyledButton
                key={kind.type}
                className='mrx-hover-row'
                onClick={() => onAdd(kind.type)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', borderRadius: 'var(--mantine-radius-sm)' }}
              >
                <ThemeIcon color={kind.color} variant='light' size={30} radius='sm' style={{ flex: '0 0 auto' }}>
                  <TablerIcon name={kind.icon} size={17} />
                </ThemeIcon>
                <Box style={{ minWidth: 0 }}>
                  <Text size='sm' fw={500}>{kind.label}</Text>
                  <Text size='xs' c='dimmed'>{kind.description}</Text>
                </Box>
              </UnstyledButton>
            ))}
          </Stack>
        );
      })}
      {kinds.length === 0 && <Text size='sm' c='dimmed'>No kind of node matches</Text>}
    </Stack>
  );
}
