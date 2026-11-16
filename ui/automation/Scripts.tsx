import { CodeMirror, Dialog, DialogActions, EmptyState, PageLoader, TablerIcon } from '@ein/ui/components';
import { fileUrl, shq } from '@ein/ui/lib';
import { execCommand, notify } from '@ein/ui/signals';
import { ActionIcon, Box, Button, Group, Select, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';

/** How long after the last keystroke a script is saved. */
const SAVE_MS = 1500;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** What a new script starts as: what it is given and how it answers. */
const STARTER = `#!bash
# Runs as the automation's owner. $VALUE is the value that came, $TOPIC where it came from,
# and each node wired in is $<its name>, with - as _. A line such as heat=on sends on on the
# output heat, when the node names it under Outputs; what else is printed goes on out.
echo "$VALUE"
`;

const failed = (error: unknown) => notify({ message: error instanceof Error ? error.message : String(error), color: 'red' });

const readScript = async (path: string): Promise<string> => {
  const res = await fetch(fileUrl(path));
  if (!res.ok) throw new Error(`could not read ${path} (${res.status})`);
  return await res.text();
};

const writeScript = async (path: string, text: string): Promise<void> => {
  const res = await fetch(fileUrl(path), { method: 'PUT', headers: { 'Content-Type': 'text/x-shellscript' }, body: text });
  if (!res.ok) throw new Error(`could not write ${path} (${res.status})`);
};

/**
 * The automation's own scripts, the files under `<its file>/scripts/`: one picked and edited at a
 * time, each change saved a moment after the last, as the YAML is. A new one is made with the
 * ordinary commands, on the db tier and its owner's alone to change, as the engine runs no other;
 * the automation's file is made passable for its owner first, since the folder hangs under it.
 */
export function Scripts({ path, scripts, editable, picked, inset, onPick, onListChanged }: {
  /** The automation's file. */
  path: string;
  scripts: string[];
  editable: boolean;
  picked: string | null;
  inset: number;
  onPick: (script: string | null) => void;
  /** The list changed: read the automation again. */
  onListChanged: () => Promise<void>;
}) {
  const folder = `${path}/scripts`;
  const current = picked && scripts.includes(picked) ? picked : null;
  const [text, setText] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [making, setMaking] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  /** The script and text a save would write: what is on screen, kept for a save when the script changes. */
  const unsaved = useRef<{ script: string; text: string } | null>(null);

  // With nothing picked, the first one.
  useEffect(() => {
    if (picked === null && scripts.length) onPick(scripts[0]);
  }, [picked, scripts]);

  const save = async () => {
    const pending = unsaved.current;
    if (!pending) return;
    unsaved.current = null;
    setSaving(true);
    try {
      await writeScript(`${folder}/${pending.script}`, pending.text);
      setSaveError(null);
      if (!unsaved.current) setDirty(false);
    } catch (error) {
      unsaved.current ??= pending;
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    setText(null);
    setLoadError(null);
    setDirty(false);
    setSaveError(null);
    if (!current) return;
    let live = true;
    readScript(`${folder}/${current}`).then((next) => live && setText(next)).catch((error) => live && setLoadError(error instanceof Error ? error.message : String(error)));
    return () => {
      live = false;
      // Another script picked, or the tab left: what waits is saved at once.
      void saveRef.current();
    };
  }, [folder, current]);

  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => void saveRef.current(), SAVE_MS);
    return () => clearTimeout(timer);
  }, [text, dirty]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (unsaved.current) event.preventDefault();
    };
    globalThis.addEventListener('beforeunload', warn);
    return () => globalThis.removeEventListener('beforeunload', warn);
  }, []);

  const nameProblem = (name: string): string | undefined =>
    !NAME.test(name) ? 'letters, digits, ., - and _, starting with a letter or digit' : scripts.includes(name) ? 'it has a script of that name' : undefined;

  const make = async (name: string) => {
    try {
      await execCommand(
        `chmod u+x ${shq(path)} && mkdir -p -m 755 ${shq(folder)} && mknode -t file --tier db -m 755 --as name=${shq(name)} --as mimetype=text/x-shellscript --an size=0 ${
          shq(`${folder}/${name}`)
        }`,
      );
      await writeScript(`${folder}/${name}`, STARTER);
      setMaking(null);
      await onListChanged();
      onPick(name);
    } catch (error) {
      failed(error);
    }
  };

  const remove = async () => {
    if (!current) return;
    try {
      unsaved.current = null;
      await execCommand(`rm ${shq(`${folder}/${current}`)}`);
      setRemoving(false);
      onPick(scripts.find((each) => each !== current) ?? null);
      await onListChanged();
    } catch (error) {
      failed(error);
    }
  };

  const state = saveError ?? (saving ? 'Saving…' : dirty ? 'Not saved yet' : current ? 'Saved' : '');
  const newButton = editable && (
    <Button
      variant='default'
      leftSection={<TablerIcon name='plus' size={16} />}
      onClick={() => setMaking(picked && !scripts.includes(picked) ? picked : 'check.sh')}
    >
      New script
    </Button>
  );

  return (
    <Stack h='100%' gap='xs' p='sm' pl={inset ? inset + 12 : undefined}>
      {scripts.length > 0 && (
        <Group gap='xs' wrap='nowrap'>
          <Select
            aria-label='Script'
            data={scripts}
            value={current}
            onChange={(next) => next && onPick(next)}
            allowDeselect={false}
            searchable
            leftSection={<TablerIcon name='script' size={16} />}
            style={{ flex: 1, minWidth: 0, maxWidth: 360 }}
          />
          {newButton}
          {editable && current && (
            <Tooltip label={`Delete ${current}`}>
              <ActionIcon variant='subtle' color='red' size={36} onClick={() => setRemoving(true)} aria-label='Delete the script'>
                <TablerIcon name='trash' size={18} />
              </ActionIcon>
            </Tooltip>
          )}
          <Text size='xs' c={saveError ? 'red' : 'dimmed'} truncate style={{ flex: '0 1 auto', minWidth: 0 }}>{state}</Text>
        </Group>
      )}
      <Box style={{ flex: 1, minHeight: 0 }}>
        {!scripts.length || !current
          ? (
            <EmptyState
              title={picked && !scripts.includes(picked) ? `It has no script ${picked}` : 'No scripts yet'}
              actions={newButton}
            >
              A script node runs one of these as the automation's owner, with what is wired into it as variables, and sends what it prints on its outputs. Only this automation
              sees them; a script shared by several goes on the PATH and is run from a shell node.
            </EmptyState>
          )
          : loadError
          ? <EmptyState title={`${current} cannot be read`}>{loadError}</EmptyState>
          : text === null
          ? <PageLoader label='Reading the script…' />
          : (
            <CodeMirror
              value={text}
              language='shell'
              readOnly={!editable}
              onChange={(next) => {
                setText(next);
                unsaved.current = { script: current, text: next };
                setDirty(true);
              }}
            />
          )}
      </Box>
      <MakeScript name={making} problem={nameProblem} onMake={make} onClose={() => setMaking(null)} />
      <Dialog opened={removing} onClose={() => setRemoving(false)} title='Delete the script?' icon='trash' pattern='danger' size='sm' floating>
        <Text size='sm'>
          <b>{current}</b> is deleted. A script node that runs it is a problem until it is given another.
        </Text>
        <DialogActions>
          <Button variant='default' onClick={() => setRemoving(false)}>Cancel</Button>
          <Button color='red' onClick={() => void remove()} data-autofocus>Delete</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

function MakeScript({ name, problem, onMake, onClose }: {
  /** The name it starts with; null while closed. */
  name: string | null;
  problem: (name: string) => string | undefined;
  onMake: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (name !== null) setValue(name);
  }, [name]);
  const wrong = value ? problem(value) : undefined;
  const submit = async () => {
    if (!value || wrong) return;
    setBusy(true);
    try {
      await onMake(value);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog opened={name !== null} onClose={onClose} title='New script' icon='script' size='sm' floating>
      <TextInput
        label='Name'
        description='A file under the automation, such as check.sh'
        value={value}
        error={wrong}
        onChange={(event) => setValue(event.currentTarget.value.trim())}
        onKeyDown={(event) => event.key === 'Enter' && void submit()}
        data-autofocus
      />
      <DialogActions>
        <Button variant='default' onClick={onClose}>Cancel</Button>
        <Button onClick={() => void submit()} loading={busy} disabled={!value || Boolean(wrong)}>Make it</Button>
      </DialogActions>
    </Dialog>
  );
}
