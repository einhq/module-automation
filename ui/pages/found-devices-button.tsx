import { TablerIcon } from '@ein/ui/components';
import { usePolledCommand } from '@ein/ui/hooks';
import { ActionIcon, Button, Indicator } from '@mantine/core';
import { useNavigate } from 'react-router-dom';
import type { FoundAnswer } from '@automation/api';

/**
 * The Devices page's way to what was found on the network (a `devices.header` panel): "3 found" while
 * something there can become a device and is none yet, opening the found devices. Nothing for a
 * reader outside the devices group, whom `automation-found` refuses.
 */
export default function FoundDevicesButton() {
  const navigate = useNavigate();
  const { data } = usePolledCommand<FoundAnswer>('automation-found --addable');
  const count = data?.devices.length ?? 0;
  if (count === 0) return null;
  const open = () => navigate('/found-devices');
  return (
    <>
      <Button className='mrx-header-wide' variant='light' leftSection={<TablerIcon name='radar' size={16} />} onClick={open}>
        {count} found
      </Button>
      <Indicator className='mrx-header-narrow' label={count} size={16} offset={4}>
        <ActionIcon variant='light' size='lg' aria-label={`${count} found on the network`} onClick={open}>
          <TablerIcon name='radar' size={18} />
        </ActionIcon>
      </Indicator>
    </>
  );
}
