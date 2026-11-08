/**
 * Where automation keeps its devices, and the routing keys their readings are published on.
 *
 *   /archive/devices/<device>                  device
 *   /archive/devices/<device>/.online          router, automation.online.<device>
 *   /archive/devices/<device>/<entity>         entity
 *   /archive/devices/<device>/<entity>/history log, bound to the entity's key
 *   /archive/devices/<device>/<entity>/live    router, publishes on the entity's key
 *   /archive/devices/<device>/<entity>/set     automation-set, for entities that can be set
 */

import type { EntityKind } from './api.ts';

export const DEVICES_ROOT = '/archive/devices';

export const DEVICE_TYPE = 'device';
export const ENTITY_TYPE = 'entity';
export const SET_TYPE = 'automation-set';

export const HISTORY_NAME = 'history';
export const LIVE_NAME = 'live';
export const SET_NAME = 'set';
export const ONLINE_NAME = '.online';
/** The entity a device's position is kept in, as a track. */
export const POSITION_NAME = 'position';

/** The group whose members administer devices and rules. */
export const AUTOMATION_GROUP = 'automation';

export const devicePath = (device: string): string => `${DEVICES_ROOT}/${device}`;
export const entityPath = (device: string, entity: string): string => `${DEVICES_ROOT}/${device}/${entity}`;

/** Where a device's position is kept: the `history` of its `position` entity, a track. */
export const positionTrackPath = (device: string): string => `${entityPath(device, POSITION_NAME)}/${HISTORY_NAME}`;

/** A button's presses are events; everything else is a state. */
export const entityKey = (device: string, entity: string, kind: EntityKind): string => `automation.${kind === 'button' ? 'event' : 'state'}.${device}.${entity}`;

export const onlineKey = (device: string): string => `automation.online.${device}`;

/** Kinds `device-set` takes a value for. */
export const SETTABLE_KINDS: readonly EntityKind[] = ['switch', 'light', 'number', 'text', 'action'];

/**
 * `<device>/<entity>`, or a path to either under the devices root, as `device` and `entity`.
 * Undefined when it names neither.
 */
export const parseTarget = (target: string): { device: string; entity?: string } | undefined => {
  const relative = target.startsWith(`${DEVICES_ROOT}/`) ? target.slice(DEVICES_ROOT.length + 1) : target;
  const parts = relative.split('/').filter(Boolean);
  if (parts.length === 0 || parts.length > 2 || parts.some((part) => part === '.' || part === '..')) return undefined;
  return parts.length === 1 ? { device: parts[0] } : { device: parts[0], entity: parts[1] };
};

/** Rules, one YAML file each, written by members of the automation group. */
export const RULES_DIR = '/etc/automation/rules';
/** Each run of a rule: what made it run and how each of its lines ended. */
export const RULES_LOG = '/var/logs/automation/rules';
/** The bus messages the rules service reads, kept while it is down. */
export const RULES_QUEUE = '/var/queues/automation-rules';
export const RULES_KEYS = ['automation.state.#', 'automation.event.#', 'automation.online.#'];
