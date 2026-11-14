import { Alert, Group, Paper, PasswordInput, Skeleton, Stack, Text, TextInput } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import type { ConfigWriteAnswer } from '@ein/api';
import { SaveBar, settingOf, SettingSource, TablerIcon, useViewSave } from '@ein/ui/components';
import { useConfig, usePolledCommand } from '@ein/ui/hooks';
import { formatDateTime } from '@ein/ui/lib';
import type { AutomationStatus } from '@automation/api';

type Draft = { url: string; user: string; password: string };

/** The host of a broker's address, or the address itself when it is not one. */
const hostOf = (url: string): string => {
  try {
    return new URL(url.trim()).host;
  } catch {
    return url.trim();
  }
};

/** Why an address is no broker's, or nothing when it is one (or empty, which is none). */
const addressProblem = (url: string): string | undefined => {
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  if (!/^mqtts?:\/\/[^/\s]+/.test(trimmed)) return 'An address starts mqtt:// or mqtts://, then the host and its port, such as mqtt://broker.example:1883.';
  return undefined;
};

/** The bridge's connection as a line with its mark. */
function Connection({ status }: { status: AutomationStatus }) {
  if (!status.configured) return <Text size='sm' c='dimmed'>No broker is set: devices are not heard over MQTT. Those EiN asks over the network are still read.</Text>;
  const since = status.since ? ` since ${formatDateTime(status.since, { dateStyle: 'medium', timeStyle: 'short' })}` : '';
  return (
    <Stack gap={4}>
      <Group gap='xs' wrap='nowrap' align='flex-start'>
        {status.connected
          ? <TablerIcon name='circle-check' size={18} color='var(--mantine-color-green-6)' />
          : <TablerIcon name='plug-connected-x' size={18} color='var(--mantine-color-yellow-6)' />}
        <Text size='sm'>
          {status.connected ? `Connected to ${status.url}${since}` : `Not connected to ${status.url}${since}`}
          {status.connected && `: ${status.devices} ${status.devices === 1 ? 'device' : 'devices'}, ${status.messages} messages heard.`}
        </Text>
      </Group>
      {!status.connected && status.lastError && <Text size='sm' c='dimmed'>{status.lastError}</Text>}
    </Stack>
  );
}

/**
 * The MQTT broker, a settings view of automation's (`automation.mqtt`, a `settings.views` panel):
 * the broker the bridge hears devices on and the account it signs in with
 * (`CFG_AUTOMATION_MQTT_URL`, `_USER`, `_KEY`), saved as one so the bridge restarts once, and
 * whether it is connected now (`automation-status`).
 */
export default function MqttSettings() {
  const config = useConfig('system');
  const { data: status, refetch } = usePolledCommand<AutomationStatus>('automation-status');
  const save = useViewSave();
  const url = settingOf(config.entries, 'CFG_AUTOMATION_MQTT_URL');
  const user = settingOf(config.entries, 'CFG_AUTOMATION_MQTT_USER');
  const key = settingOf(config.entries, 'CFG_AUTOMATION_MQTT_KEY');

  const saved = useMemo<Draft | undefined>(() => (url && user ? { url: url.value, user: user.value, password: '' } : undefined), [url?.value, user?.value]);
  const [draft, setDraft] = useState<Draft | undefined>(saved);
  useEffect(() => setDraft(saved), [saved]);

  if (config.loading) return <Skeleton height={280} radius='md' />;
  if (!saved || !key) return <Text c='dimmed'>{config.error?.message ?? 'The MQTT settings did not load.'}</Text>;
  if (!draft) return <Skeleton height={280} radius='md' />;

  const change = (next: Partial<Draft>) => {
    save.clear();
    setDraft({ ...draft, ...next });
  };
  const dirty = draft.url.trim() !== saved.url || draft.user.trim() !== saved.user || draft.password !== '';
  const sameHost = hostOf(draft.url) === hostOf(saved.url);
  const keySet = key.source !== 'default';
  const problem = addressProblem(draft.url);
  const blocked = problem ??
    (!sameHost && !draft.password && key.source === 'environment' && draft.user.trim()
      ? "The password in the installation's .env belongs to the broker it names there; give this one its own."
      : undefined);

  const write = async (): Promise<ConfigWriteAnswer[]> => {
    const answers = [
      await config.saveAll({
        CFG_AUTOMATION_MQTT_URL: draft.url.trim(),
        CFG_AUTOMATION_MQTT_USER: draft.user.trim(),
        ...(draft.password ? { CFG_AUTOMATION_MQTT_KEY: draft.password } : {}),
      }),
    ];
    // Another broker without a password of its own: the one set here was the old broker's.
    if (!sameHost && !draft.password && key.source === 'system') answers.push(await config.resetAll(['CFG_AUTOMATION_MQTT_KEY']));
    return answers;
  };
  const onSave = async () => {
    await save.run(write);
    // The bridge connects again as it restarts; ask once it has had a moment to.
    setTimeout(refetch, 2000);
  };

  return (
    <Stack gap='lg'>
      <Paper p='md' radius='md' withBorder>
        <Stack gap='sm'>
          <TextInput
            label={
              <Group gap='xs' component='span'>
                Broker
                <SettingSource entry={url!} />
              </Group>
            }
            description='The broker devices talk to, such as mqtt://broker.example:1883, or mqtts:// with its TLS port. Empty, no device is heard over MQTT. setup.sh --automation runs one beside EiN and sets it.'
            placeholder='mqtt://host:1883'
            value={draft.url}
            error={problem}
            disabled={save.busy}
            onChange={(event) => change({ url: event.currentTarget.value })}
          />
          <TextInput
            label='User'
            description='The account EiN signs in to the broker with. Empty, it signs in without one.'
            value={draft.user}
            disabled={save.busy}
            onChange={(event) => change({ user: event.currentTarget.value })}
          />
          <PasswordInput
            label='Password'
            description='Sent to this broker alone, and kept where only an administrator reads it.'
            placeholder={sameHost && keySet ? 'Set — type a new one to replace it' : 'None'}
            autoComplete='new-password'
            value={draft.password}
            disabled={save.busy}
            onChange={(event) => change({ password: event.currentTarget.value })}
          />
        </Stack>
      </Paper>

      <SaveBar save={save} dirty={dirty} blocked={blocked} onCancel={() => setDraft(saved)} onSave={onSave} />

      <Paper p='md' radius='md' withBorder>
        <Stack gap='xs'>
          <Text fw={600}>Now</Text>
          {status ? <Connection status={status} /> : <Skeleton height={20} />}
          {status && !status.running && (
            <Alert color='yellow' variant='light' icon={<TablerIcon name='alert-triangle' size={16} />} p='xs'>
              The bridge is not running, so nothing is heard whatever is set here. Start automation-bridge on Status → Services.
            </Alert>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}
