import { Skeleton, Stack, Text, UnstyledButton } from '@mantine/core';
import type { DeviceInfo, DeviceValue, EndpointSummary } from '@ein/api';
import { TablerIcon } from '@ein/ui/components';
import { usePolledCommand } from '@ein/ui/hooks';
import { agoText, readingText, shq } from '@ein/ui/lib';
import { execCommand, notify } from '@ein/ui/signals';
import { type ReactNode, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/** How long a press must be followed by another before a button that asks first forgets it. */
const ARMED_MS = 4_000;

/** How long a pressed momentary button stays lit. */
const PRESSED_MS = 1_500;

/** What pressing the button does to its control. */
type Action =
  /** A momentary control: a press. */
  | { kind: 'press' }
  /** On and off: the other of what it is. */
  | { kind: 'toggle' }
  /** Any other: this value, which it is lit at. */
  | { kind: 'set'; value: string };

/** What pressing does to `endpoint`, or why the button cannot press it. */
const actionOf = (endpoint: EndpointSummary, value: string): Action | string => {
  if (endpoint.type !== 'control') return `${endpoint.label} is a reading, not something to press or switch`;
  const type = endpoint.schema?.type ?? 'text';
  if (type === 'momentary') return { kind: 'press' };
  if (value !== '') return { kind: 'set', value };
  if (type === 'bool') return { kind: 'toggle' };
  return `Set what the button sets ${endpoint.label} to in the card's settings`;
};

/** Whether what a control is now is the value a button sets it to, read as the device says it. */
const isValue = (now: DeviceValue | undefined, value: string): boolean => {
  if (now === undefined || now === null) return false;
  if (typeof now === 'boolean') return now === ['on', 'true', '1'].includes(value.toLowerCase());
  if (typeof now === 'number') return value.trim() !== '' && Number(value) === now;
  return String(now) === value;
};

/** The control's value as the button shows it: what was asked while the device has not said it yet. */
const shownValue = (endpoint: EndpointSummary): DeviceValue | undefined => {
  const { requested, last } = endpoint;
  if (requested && (!last || Date.parse(last.at) < Date.parse(requested.at))) return requested.value;
  return last?.value;
};

/** What a tile says in place of its button, in the middle. */
function Quiet({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <Stack h='100%' align='center' justify='center' gap={6} p='sm' ta='center'>
      <TablerIcon name={icon} size={26} stroke={1.5} />
      <Text size='sm' c='dimmed' maw={260}>{children}</Text>
    </Stack>
  );
}

/**
 * `/cards/automation/button`: one large button for a device's control (`device`, `endpoint`), lit
 * while the control is what it sets. A momentary control is pressed; on and off is switched to the
 * other, or to `value` when one is given; any other control is set to `value`, as for a scene or a
 * mode. With `confirm` the first press only asks for a second. A button whose control its viewer may
 * not write, as on a screen that only shows, shows the state and does nothing.
 */
export default function ButtonCard() {
  const [params] = useSearchParams();
  const device = params.get('device') ?? '';
  const name = params.get('endpoint') ?? '';
  const value = params.get('value') ?? '';
  const confirm = params.get('confirm') === 'true';
  const info = usePolledCommand<DeviceInfo>(`device-show ${shq(device)}`, device !== '');
  const [busy, setBusy] = useState(false);
  const [armedAt, setArmedAt] = useState<number>();
  const [pressedAt, setPressedAt] = useState<number>();

  useEffect(() => {
    if (armedAt === undefined) return;
    const timer = setTimeout(() => setArmedAt(undefined), ARMED_MS);
    return () => clearTimeout(timer);
  }, [armedAt]);
  useEffect(() => {
    if (pressedAt === undefined) return;
    const timer = setTimeout(() => setPressedAt(undefined), PRESSED_MS);
    return () => clearTimeout(timer);
  }, [pressedAt]);

  if (!info.data) return info.error ? <Quiet icon='plug-x'>{info.error.message}</Quiet> : <Skeleton h='100%' radius='md' />;
  const endpoint = info.data.endpointList.find((each) => each.name === name);
  if (!endpoint) return <Quiet icon='plug-x'>{info.data.label} has no {name || 'control chosen'}.</Quiet>;
  const action = actionOf(endpoint, value);
  if (typeof action === 'string') return <Quiet icon='adjustments'>{action}</Quiet>;

  const now = shownValue(endpoint);
  const pending = action.kind !== 'press' && now !== endpoint.last?.value;
  const lit = action.kind === 'press' ? pressedAt !== undefined : action.kind === 'toggle' ? now === true : isValue(now, action.value);
  const label = params.get('label') || endpoint.label;
  const icon = params.get('icon') || (action.kind === 'press' ? 'hand-finger' : action.kind === 'toggle' ? 'power' : 'player-play');
  const disabled = !endpoint.writable || busy;

  const write = async () => {
    const written = action.kind === 'press' ? 'press' : action.kind === 'toggle' ? (now === true ? 'off' : 'on') : action.value;
    setBusy(true);
    try {
      await execCommand(`echo ${shq(written)} > ${shq(endpoint.path)}`);
      if (action.kind === 'press') setPressedAt(Date.now());
      await info.refetch();
    } catch (error) {
      notify({ message: error instanceof Error ? error.message : String(error), color: 'red' });
    } finally {
      setBusy(false);
    }
  };
  const press = () => {
    if (confirm && armedAt === undefined) return setArmedAt(Date.now());
    setArmedAt(undefined);
    void write();
  };

  const state = armedAt !== undefined
    ? 'Press again'
    : pending
    ? 'Waiting for the device…'
    : action.kind === 'press'
    ? endpoint.requested ? `Pressed ${agoText(endpoint.requested.at)}` : 'Not pressed yet'
    : action.kind === 'toggle'
    ? now === true ? 'On' : now === false ? 'Off' : 'Not known'
    : lit
    ? 'On'
    : now === undefined
    ? 'Not known'
    : readingText(now, endpoint.unit);

  return (
    <UnstyledButton
      onClick={press}
      disabled={disabled}
      aria-pressed={action.kind === 'press' ? undefined : lit}
      title={endpoint.writable ? undefined : 'You may not use this button'}
      className='automation-button-card'
      data-lit={lit || undefined}
      data-armed={armedAt !== undefined || undefined}
      data-pending={pending || busy || undefined}
      style={{
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.4em',
        padding: '0.6em',
        borderRadius: 'var(--mantine-radius-md)',
        fontSize: 'clamp(0.85rem, 7cqmin, 1.8rem)',
        textAlign: 'center',
        cursor: endpoint.writable ? 'pointer' : 'default',
      }}
    >
      <TablerIcon name={icon} size='2.2em' stroke={1.6} />
      <Text inherit fw={650} lineClamp={2}>{label}</Text>
      <Text inherit size='0.7em' c={lit || armedAt !== undefined ? undefined : 'dimmed'} style={{ opacity: 0.85 }}>{state}</Text>
      <style>
        {`.automation-button-card { color: var(--mantine-color-text); background: var(--mantine-color-default-hover); transition: background 160ms, color 160ms, transform 80ms; }
.automation-button-card:not(:disabled):active { transform: scale(0.97); }
.automation-button-card[data-lit] { background: var(--mantine-primary-color-filled); color: var(--mantine-primary-color-contrast); }
.automation-button-card[data-armed] { background: var(--mantine-color-orange-filled); color: white; }
.automation-button-card[data-pending] { animation: automation-button-pending 1.2s ease-in-out infinite alternate; }
.automation-button-card:disabled:not([data-pending]) { opacity: 0.75; }
@keyframes automation-button-pending { to { opacity: 0.6; } }
@media (prefers-reduced-motion: reduce) { .automation-button-card { animation: none !important; transition: none; } }`}
      </style>
    </UnstyledButton>
  );
}
