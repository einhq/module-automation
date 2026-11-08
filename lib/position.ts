/**
 * A device's position: an `entity` of kind `position` whose `history` is a core `track` of GPS
 * fixes, filled by a phone or GPS tracker posting to core's `/tracker` link (`device-tracker`) or
 * by GPX files imported into it.
 */

import type { Command } from '@ein/client';
import type { EntityAttrs } from './api.ts';
import { devicePath, ENTITY_TYPE, HISTORY_NAME, POSITION_NAME, positionTrackPath } from './paths.ts';

/** The device's position track, made with its entity when it has none. Answers the track's path. */
export const ensurePosition = async (cmd: Command, device: string): Promise<string> => {
  const track = positionTrackPath(device);
  if (await cmd.sys.vfs.exists(cmd.access, track)) return track;
  const attrs: EntityAttrs = { label: 'Position', kind: 'position' };
  if (!(await cmd.sys.vfs.exists(cmd.access, `${devicePath(device)}/${POSITION_NAME}`))) {
    await cmd.sys.vfs.createTree(cmd.access, devicePath(device), [{
      type: ENTITY_TYPE,
      name: POSITION_NAME,
      attrs,
      children: [{ type: 'track', name: HISTORY_NAME, attrs: {} }],
    }]);
  } else {
    await cmd.sys.vfs.create(cmd.access, 'track', `${devicePath(device)}/${POSITION_NAME}`, HISTORY_NAME, { attrs: {} });
  }
  return track;
};
