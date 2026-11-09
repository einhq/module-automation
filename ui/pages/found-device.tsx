import { CodeMirror, PageLoader } from '@ein/ui/components';
import { useCommand, useSurface } from '@ein/ui/hooks';
import { formatDateTime, shq } from '@ein/ui/lib';
import { Alert, Badge, Container, Group, Stack, Table, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import type { FoundDetail } from '@automation/api';

/** The shell's dialog takes its frame from here, wide for the raw message; as a page, this is its heading. */
export const handle = { title: 'Found on the network', icon: 'radar', pattern: 'device', dialogSize: 'xl', signedIn: true };

/** As a page, a heading and a width of its own; in the dialog, the dialog's. */
function Frame({ children }: { children: ReactNode }) {
  const surface = useSurface();
  if (surface.kind !== 'page') return <>{children}</>;
  return (
    <Container size='md' py='xl'>
      <Title order={2} mb='lg'>{handle.title}</Title>
      {children}
    </Container>
  );
}

/** Rows of a key-value table, the empty ones left out. */
function Pairs({ rows }: { rows: [string, string | number | undefined][] }) {
  const shown = rows.filter(([, value]) => value !== undefined && value !== '');
  if (!shown.length) return null;
  return (
    <Table withRowBorders={false} verticalSpacing={2} fz='sm'>
      <Table.Tbody>
        {shown.map(([key, value]) => (
          <Table.Tr key={key}>
            <Table.Td c='dimmed' w='35%' style={{ verticalAlign: 'top', wordBreak: 'break-all' }}>{key}</Table.Td>
            <Table.Td style={{ wordBreak: 'break-all' }}>{String(value)}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

/**
 * Everything the network listener heard of one host (`/found-devices/:id`, opened as a dialog from
 * a card): what EiN makes of it, each mDNS service with its TXT records, each SSDP answer with what
 * its UPnP description says, and the whole message, raw. For a device EiN does not support yet, it
 * is what there is to go on.
 */
export default function FoundDevicePage() {
  const { id = '' } = useParams();
  const { data, loading, error } = useCommand<FoundDetail>(`automation-found ${shq(id)}`);
  return (
    <Frame>
      {error && <Alert color='red'>{error.message}</Alert>}
      {loading && !data ? <PageLoader /> : data && (
        <Stack gap='md'>
          <Title order={4}>{data.label}</Title>
          <Pairs
            rows={[
              ['what it is', data.kind],
              ['maker', data.vendor],
              ['model', data.model],
              ['firmware', data.firmware],
              ['address', data.ip],
              ['hardware address', data.mac],
              ['names', data.names.join(', ')],
              ['last heard', formatDateTime(data.seen)],
              ['added with', data.adopt],
              ['device', data.device],
            ]}
          />
          {data.connect && <Text size='sm' c='dimmed'>{data.connect}</Text>}
          {data.host.mdns.length > 0 && <Title order={5}>mDNS</Title>}
          {data.host.mdns.map((service) => (
            <Stack key={`${service.type} ${service.instance}`} gap={4}>
              <Group gap='xs'>
                <Badge variant='light' tt='none'>{service.type}</Badge>
                <Text size='sm' fw={500}>{service.instance}</Text>
                {service.port !== undefined && <Text size='sm' c='dimmed'>port {service.port}</Text>}
              </Group>
              <Pairs rows={Object.entries(service.txt)} />
            </Stack>
          ))}
          {data.host.ssdp.length > 0 && <Title order={5}>SSDP</Title>}
          {data.host.ssdp.map((answer) => (
            <Stack key={`${answer.st} ${answer.usn ?? ''}`} gap={4}>
              <Badge variant='light' color='grape' tt='none'>{answer.st}</Badge>
              <Pairs
                rows={[
                  ['name', answer.friendlyName],
                  ['maker', answer.manufacturer],
                  ['model', [answer.modelName, answer.modelNumber].filter(Boolean).join(' ')],
                  ['serial', answer.serialNumber],
                  ['type', answer.deviceType],
                  ['server', answer.server],
                  ['description', answer.location],
                  ['usn', answer.usn],
                ]}
              />
            </Stack>
          ))}
          <Title order={5}>Raw</Title>
          <CodeMirror value={JSON.stringify(data.host, null, 2)} language='json' readOnly height='360px' />
        </Stack>
      )}
    </Frame>
  );
}
