import { Group, Paper, PasswordInput, Skeleton, Stack, Text, TextInput } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import type { ConfigWriteAnswer } from '@ein/api';
import { SaveBar, settingOf, SettingSource, TablerIcon, useViewSave } from '@ein/ui/components';
import { useCommand, useConfig } from '@ein/ui/hooks';
import type { RestreamerStatus } from '@automation/api';

type Draft = { url: string; rtsp: string; password: string };

/** The host of an address, or the address itself when it is not one. */
const hostOf = (url: string): string => {
  try {
    return new URL(url.trim()).host;
  } catch {
    return url.trim();
  }
};

/** Why an address does not start with one of `schemes`, or nothing when it does (or is empty, which is none). */
const addressProblem = (url: string, schemes: string[], example: string): string | undefined => {
  const trimmed = url.trim();
  if (!trimmed || schemes.some((scheme) => new RegExp(`^${scheme}://[^/\\s]+`).test(trimmed))) return undefined;
  return `An address starts ${schemes.map((scheme) => `${scheme}://`).join(' or ')}, then the host and its port, such as ${example}.`;
};

/** Whether the restreamer answers, as a line with its mark. */
function Answer({ status }: { status: RestreamerStatus }) {
  if (!status.configured) {
    return <Text size='sm' c='dimmed'>No restreamer is set: a camera has no live view, and its picture is asked of the camera itself.</Text>;
  }
  return (
    <Group gap='xs' wrap='nowrap' align='flex-start'>
      {status.answering
        ? <TablerIcon name='circle-check' size={18} color='var(--mantine-color-green-6)' />
        : <TablerIcon name='plug-connected-x' size={18} color='var(--mantine-color-yellow-6)' />}
      <Text size='sm'>
        {status.answering
          ? `${status.url} answers, with ${status.streams} ${status.streams === 1 ? 'stream' : 'streams'}.`
          : `${status.url} does not answer: ${status.error ?? 'no reason given'}.`}
      </Text>
    </Group>
  );
}

/**
 * The restreamer, a settings view of automation's (`automation.restreamer`, a `settings.views`
 * panel): go2rtc's API, which cameras are given to and their live views and pictures come from
 * (`CFG_AUTOMATION_STREAMS_URL`), its RTSP as the media service reaches it
 * (`CFG_AUTOMATION_STREAMS_RTSP`) and the password of its account `ein`
 * (`CFG_AUTOMATION_STREAMS_KEY`), saved as one so the bridge restarts once; then whether it
 * answers that account (`automation-status --streams`).
 */
export default function RestreamerSettings() {
  const config = useConfig('system');
  const status = useCommand<RestreamerStatus>('automation-status --streams');
  const save = useViewSave();
  const url = settingOf(config.entries, 'CFG_AUTOMATION_STREAMS_URL');
  const rtsp = settingOf(config.entries, 'CFG_AUTOMATION_STREAMS_RTSP');
  const key = settingOf(config.entries, 'CFG_AUTOMATION_STREAMS_KEY');

  const saved = useMemo<Draft | undefined>(() => (url && rtsp ? { url: url.value, rtsp: rtsp.value, password: '' } : undefined), [url?.value, rtsp?.value]);
  const [draft, setDraft] = useState<Draft | undefined>(saved);
  useEffect(() => setDraft(saved), [saved]);

  if (config.loading) return <Skeleton height={300} radius='md' />;
  if (!saved || !key) return <Text c='dimmed'>{config.error?.message ?? 'The restreamer settings did not load.'}</Text>;
  if (!draft) return <Skeleton height={300} radius='md' />;

  const change = (next: Partial<Draft>) => {
    save.clear();
    setDraft({ ...draft, ...next });
  };
  const dirty = draft.url.trim() !== saved.url || draft.rtsp.trim() !== saved.rtsp || draft.password !== '';
  const sameHost = hostOf(draft.url) === hostOf(saved.url);
  const keySet = key.source !== 'default';
  const urlProblem = addressProblem(draft.url, ['http', 'https'], 'http://127.0.0.1:1984');
  const rtspProblem = addressProblem(draft.rtsp, ['rtsp', 'rtsps'], 'rtsp://127.0.0.1:8554');
  const blocked = urlProblem ?? rtspProblem ??
    (!sameHost && !draft.password && key.source === 'environment' && draft.url.trim()
      ? "The password in the installation's .env belongs to the restreamer it names there; give this one its own."
      : undefined);

  const write = async (): Promise<ConfigWriteAnswer[]> => {
    const answers = [
      await config.saveAll({
        CFG_AUTOMATION_STREAMS_URL: draft.url.trim(),
        CFG_AUTOMATION_STREAMS_RTSP: draft.rtsp.trim(),
        ...(draft.password ? { CFG_AUTOMATION_STREAMS_KEY: draft.password } : {}),
      }),
    ];
    // Another restreamer without a password of its own: the one set here was the old one's.
    if (!sameHost && !draft.password && key.source === 'system') answers.push(await config.resetAll(['CFG_AUTOMATION_STREAMS_KEY']));
    return answers;
  };
  const onSave = async () => {
    if (await save.run(write)) setDraft((current) => current && { ...current, password: '' });
    status.refetch();
  };

  return (
    <Stack gap='lg'>
      <Paper p='md' radius='md' withBorder>
        <Stack gap='sm'>
          <TextInput
            label={
              <Group gap='xs' component='span'>
                Restreamer
                <SettingSource entry={url!} />
              </Group>
            }
            description="go2rtc's API, which every camera is given to, and its live view and picture come from. setup.sh --automation runs one beside EiN and sets this. Empty, a camera has no live view, and its picture is asked of the camera itself."
            placeholder='http://127.0.0.1:1984'
            value={draft.url}
            error={urlProblem}
            disabled={save.busy}
            onChange={(event) => change({ url: event.currentTarget.value })}
          />
          <TextInput
            label={
              <Group gap='xs' component='span'>
                For the media service
                <SettingSource entry={rtsp!} />
              </Group>
            }
            description="The restreamer's RTSP as the media service reaches it, where it reads a camera's stream to watch it for faces. Empty, no camera is watched."
            placeholder='rtsp://127.0.0.1:8554'
            value={draft.rtsp}
            error={rtspProblem}
            disabled={save.busy}
            onChange={(event) => change({ rtsp: event.currentTarget.value })}
          />
          <PasswordInput
            label={
              <Group gap='xs' component='span'>
                Password
                <SettingSource entry={key} />
              </Group>
            }
            description="The password of the restreamer's account ein. Sent to this restreamer alone, and kept where nobody reads it back."
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
          {status.data
            ? <Answer status={status.data} />
            : status.loading
            ? <Skeleton height={20} />
            : <Text size='sm' c='dimmed'>{status.error?.message ?? 'No answer.'}</Text>}
          {status.data?.configured && <Text size='xs' c='dimmed'>Whether the media service reaches the RTSP address is seen only when it watches a camera.</Text>}
        </Stack>
      </Paper>
    </Stack>
  );
}
