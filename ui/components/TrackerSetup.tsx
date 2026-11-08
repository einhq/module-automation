import { ActionIcon, Anchor, Box, Button, Group, Image, List, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TablerIcon } from '@ein/ui/components';
import { copyText, shq } from '@ein/ui/lib';
import { execCommand, notify } from '@ein/ui/signals';
import type { DeviceTracker } from '../../lib/api.ts';

const TRACCAR_CLIENT = 'https://www.traccar.org/client/';

/**
 * Live tracking from a phone, as the body of its dialog: the QR code that sets Traccar Client up to
 * post the device's position to its track, the server URL to type in by hand, and turning it on,
 * replacing the link and turning it off. `device` is the device's slug; only someone who may change the device is shown this.
 */
export function TrackerSetup({ device }: { device: string }) {
  const [setup, setSetup] = useState<DeviceTracker>();
  const [pending, setPending] = useState<'new' | 'off'>();
  const [confirmNew, setConfirmNew] = useState(false);
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const run = useCallback(async (flag?: '--new' | '--off') => {
    const answer = await execCommand<DeviceTracker>(`device-tracker ${shq(device)} --origin ${shq(globalThis.location.origin)}${flag ? ` ${flag}` : ''}`);
    setSetup(answer);
    return answer;
  }, [device]);

  useEffect(() => {
    run().catch((error) => notify({ message: error instanceof Error ? error.message : String(error), color: 'red' }));
  }, [run]);

  const change = async (flag: '--new' | '--off') => {
    setPending(flag === '--new' ? 'new' : 'off');
    try {
      await run(flag);
      setConfirmNew(false);
    } catch (error) {
      notify({ message: error instanceof Error ? error.message : String(error), color: 'red' });
    } finally {
      setPending(undefined);
    }
  };

  const copy = async () => {
    if (!setup?.url) return;
    if (!(await copyText(setup.url, input.current))) {
      notify({ message: 'The browser would not copy the address: it is selected for you to copy.', color: 'yellow' });
      return;
    }
    notify({ message: 'Server URL copied to clipboard' });
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!setup) return null;

  return (
    <Stack gap='md'>
      <Group justify='space-between' align='flex-start' wrap='nowrap'>
        <Text size='sm' c='dimmed'>
          {setup.enabled
            ? 'A phone running Traccar Client posts its position to this track, as it moves.'
            : 'Let a phone, or a GPS tracker that posts over HTTP, add its position to this track as it moves.'}
        </Text>
        {!setup.enabled && (
          // Kept at its own width: beside the text it would be squeezed until its label is clipped.
          <Button leftSection={<TablerIcon name='broadcast' size={16} />} loading={pending === 'new'} onClick={() => change('--new')} style={{ flexShrink: 0 }}>
            Turn on
          </Button>
        )}
      </Group>

      {setup.enabled && setup.url && (
        <Group align='flex-start' gap='xl'>
          {setup.qrSvg && (
            <Box bg='white' p={4} style={{ borderRadius: 'var(--mantine-radius-sm)', flex: 'none' }}>
              <Image src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qrSvg)}`} w={200} h={200} alt='QR code that sets Traccar Client up' />
            </Box>
          )}
          <Stack gap='sm' style={{ flex: 1, minWidth: 260 }}>
            <List type='ordered' size='sm' spacing={6}>
              <List.Item>
                Install <Anchor href={TRACCAR_CLIENT} target='_blank' rel='noreferrer'>Traccar Client</Anchor> on the phone, from Google Play or the App Store.
              </List.Item>
              <List.Item>In its settings, scan this QR code. It fills in the server URL and the device identifier.</List.Item>
              <List.Item>Set how often it reports, for example every 30 seconds, and switch tracking on.</List.Item>
            </List>
            <TextInput
              ref={input}
              size='xs'
              readOnly
              label='Or type the server URL in by hand'
              value={setup.url}
              onClick={copy}
              rightSectionPointerEvents='all'
              rightSection={
                <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
                  <ActionIcon variant='subtle' color={copied ? 'teal' : 'gray'} size='sm' onClick={copy} aria-label='Copy the server URL'>
                    <TablerIcon name={copied ? 'check' : 'copy'} size={14} />
                  </ActionIcon>
                </Tooltip>
              }
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', cursor: 'pointer' } }}
            />
            <Text size='xs' c='dimmed'>
              The phone has to reach EiN at this address from wherever it is, over HTTPS. Anyone who has the address can add positions to the track: make a new one if it got
              out.
            </Text>
            <Group gap='xs'>
              {confirmNew
                ? (
                  <>
                    <Text size='sm'>The phone stops reporting until it is given the new address.</Text>
                    <Button size='xs' color='red' loading={pending === 'new'} onClick={() => change('--new')}>Make a new link</Button>
                    <Button size='xs' variant='default' onClick={() => setConfirmNew(false)}>Cancel</Button>
                  </>
                )
                : (
                  <>
                    <Button
                      size='xs'
                      variant='default'
                      leftSection={<TablerIcon name='refresh' size={14} />}
                      onClick={() => setConfirmNew(true)}
                      disabled={pending !== undefined}
                    >
                      New link
                    </Button>
                    <Button
                      size='xs'
                      variant='default'
                      color='red'
                      leftSection={<TablerIcon name='broadcast-off' size={14} />}
                      loading={pending === 'off'}
                      disabled={pending === 'new'}
                      onClick={() => change('--off')}
                    >
                      Turn off
                    </Button>
                  </>
                )}
            </Group>
          </Stack>
        </Group>
      )}
    </Stack>
  );
}
