import { PageLoader } from '@ein/ui/components';
import { useCommand } from '@ein/ui/hooks';
import { shq } from '@ein/ui/lib';
import { Alert, Badge, Code, Group, Modal, Stack, Table, Text, Title } from '@mantine/core';
import type { FoundDetail } from '@automation/api';

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
 * Everything the network listener heard of one host, as it came: what EiN makes of it, each mDNS
 * service with its TXT records, each SSDP answer with what its UPnP description says, and the whole
 * message. For a device EiN does not support yet, it is what there is to go on.
 */
export function FoundDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, loading, error } = useCommand<FoundDetail>(`automation-found ${shq(id)}`);
  return (
    <Modal opened onClose={onClose} size='lg' title={data?.label ?? 'Found on the network'}>
      {error && <Alert color='red'>{error.message}</Alert>}
      {loading && !data ? <PageLoader /> : data && (
        <Stack gap='md'>
          <Pairs
            rows={[
              ['what it is', data.kind],
              ['maker', data.vendor],
              ['model', data.model],
              ['firmware', data.firmware],
              ['address', data.ip],
              ['hardware address', data.mac],
              ['names', data.names.join(', ')],
              ['last heard', new Date(data.seen).toLocaleString()],
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
          <Title order={5}>As heard</Title>
          <Code block style={{ maxHeight: 320, overflow: 'auto' }}>{JSON.stringify(data.host, null, 2)}</Code>
        </Stack>
      )}
    </Modal>
  );
}
