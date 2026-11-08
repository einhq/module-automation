/**
 * Reading devices and entities back, as the caller may see them: what `devices`,
 * `device-show` and `device-history` answer. A value is the last entry of the entity's history.
 */

import { type Command, readTail } from '@ein/client';
import type { DeviceAttrs, DeviceInfo, DeviceSummary, EntityAttrs, EntitySummary, Reading, Value } from './api.ts';
import { DEVICE_TYPE, devicePath, DEVICES_ROOT, ENTITY_TYPE, entityPath, HISTORY_NAME, SET_NAME, SETTABLE_KINDS } from './paths.ts';

/** A command's failure, said once on stderr. */
export const fail = async (cmd: Command, name: string, error: unknown): Promise<number> => {
  await cmd.writeError(`${name}: ${error instanceof Error ? error.message : error}\n`);
  return 1;
};

/** The last `limit` readings of an entity, oldest first. */
export const readingsOf = async (cmd: Command, device: string, entity: string, limit: number): Promise<{ at: string; value: Value }[]> => {
  const samples = await readTail<Reading>(cmd.sys.vfs, cmd.access, `${entityPath(device, entity)}/${HISTORY_NAME}`, limit);
  return samples
    .filter((sample) => sample.value !== null && typeof sample.value === 'object' && 'value' in sample.value)
    .map((sample) => ({ at: new Date(sample.at).toISOString(), value: sample.value.value }));
};

const lastOf = async (cmd: Command, device: string, entity: string): Promise<{ value: Value; at: string } | undefined> => (await readingsOf(cmd, device, entity, 1))[0];

/** The entities of a device, without their values, in name order. */
const entitiesOf = async (cmd: Command, device: string): Promise<{ name: string; attrs: EntityAttrs; settable: boolean }[]> => {
  const children = await cmd.sys.vfs.children<EntityAttrs>(cmd.access, devicePath(device));
  const entities = children.filter((child) => child.node.type === ENTITY_TYPE).sort((a, b) => a.name.localeCompare(b.name));
  return await Promise.all(entities.map(async (child) => ({
    name: child.name,
    attrs: child.node.attrs,
    settable: SETTABLE_KINDS.includes(child.node.attrs.kind) && await cmd.sys.vfs.exists(cmd.access, `${entityPath(device, child.name)}/${SET_NAME}`),
  })));
};

/** What a card would rather show, first to last. */
const MAIN_CLASSES = ['temperature', 'power', 'humidity', 'illuminance', 'energy'];

/**
 * The entity a card shows: a sensor of the first of `MAIN_CLASSES` the device has, else its first
 * sensor, else its first switch or light; never one about the device itself (`category`).
 */
const mainOf = <T extends { attrs: EntityAttrs }>(entities: T[]): T | undefined => {
  const live = entities.filter((entity) => !entity.attrs.retired && entity.attrs.supported !== false && !entity.attrs.category);
  const sensors = live.filter((entity) => entity.attrs.kind === 'sensor');
  for (const deviceClass of MAIN_CLASSES) {
    const found = sensors.find((entity) => entity.attrs.deviceClass === deviceClass);
    if (found) return found;
  }
  return sensors[0] ?? live.find((entity) => entity.attrs.kind === 'switch' || entity.attrs.kind === 'light');
};

const summary = (device: string, attrs: DeviceAttrs, entities: number): DeviceSummary => ({
  name: device,
  path: devicePath(device),
  label: attrs.label ?? device,
  source: attrs.source ?? '',
  ...(attrs.manufacturer ? { manufacturer: attrs.manufacturer } : {}),
  ...(attrs.model ? { model: attrs.model } : {}),
  ...(typeof attrs.online === 'boolean' ? { online: attrs.online } : {}),
  entities,
});

/** Every device the caller may see, by label. */
export const listDevices = async (cmd: Command): Promise<DeviceSummary[]> => {
  const children = await cmd.sys.vfs.children<DeviceAttrs>(cmd.access, DEVICES_ROOT).catch(() => []);
  const devices = children.filter((child) => child.node.type === DEVICE_TYPE);
  const summaries = await Promise.all(devices.map(async (child) => {
    const entities = await entitiesOf(cmd, child.name).catch(() => []);
    const result = summary(child.name, child.node.attrs, entities.length);
    const main = mainOf(entities);
    const last = main ? await lastOf(cmd, child.name, main.name) : undefined;
    if (main && last) {
      result.main = { entity: main.name, label: main.attrs.label, value: last.value, ...(main.attrs.unit ? { unit: main.attrs.unit } : {}) };
      result.lastAt = last.at;
    }
    return result;
  }));
  return summaries.sort((a, b) => a.label.localeCompare(b.label));
};

const entitySummary = (device: string, entity: { name: string; attrs: EntityAttrs; settable: boolean }, last?: { value: Value; at: string }): EntitySummary => ({
  name: entity.name,
  path: entityPath(device, entity.name),
  label: entity.attrs.label ?? entity.name,
  kind: entity.attrs.kind,
  ...(entity.attrs.unit ? { unit: entity.attrs.unit } : {}),
  ...(entity.attrs.deviceClass ? { deviceClass: entity.attrs.deviceClass } : {}),
  ...(entity.attrs.category ? { category: entity.attrs.category } : {}),
  ...(entity.attrs.options ? { options: entity.attrs.options } : {}),
  ...(typeof entity.attrs.min === 'number' ? { min: entity.attrs.min } : {}),
  ...(typeof entity.attrs.max === 'number' ? { max: entity.attrs.max } : {}),
  supported: entity.attrs.supported !== false,
  retired: entity.attrs.retired === true,
  settable: entity.settable,
  ...(last ? { last } : {}),
});

/** A device and its entities with their last values. */
export const deviceInfo = async (cmd: Command, device: string): Promise<DeviceInfo> => {
  const node = await cmd.sys.vfs.get<DeviceAttrs>(cmd.access, devicePath(device));
  if (node.type !== DEVICE_TYPE) throw new Error(`${device} is not a device`);
  const entities = await entitiesOf(cmd, device);
  const lasts = await Promise.all(entities.map((entity) => lastOf(cmd, device, entity.name)));
  const entityList = entities.map((entity, i) => entitySummary(device, entity, lasts[i]));
  const info: DeviceInfo = {
    ...summary(device, node.attrs, entities.length),
    ...(node.attrs.sw ? { sw: node.attrs.sw } : {}),
    ...(node.attrs.mac ? { mac: node.attrs.mac } : {}),
    entityList,
  };
  const main = mainOf(entities);
  const mainLast = main ? lasts[entities.indexOf(main)] : undefined;
  if (main && mainLast) info.main = { entity: main.name, label: main.attrs.label, value: mainLast.value, ...(main.attrs.unit ? { unit: main.attrs.unit } : {}) };
  const latest = lasts.filter((last) => last !== undefined).map((last) => last.at).sort().at(-1);
  if (latest) info.lastAt = latest;
  return info;
};

/** An entity of a device, as `<device>/<entity>` names it. */
export const entityOf = async (cmd: Command, device: string, entity: string): Promise<EntitySummary> => {
  const node = await cmd.sys.vfs.get<EntityAttrs>(cmd.access, entityPath(device, entity)).catch(() => undefined);
  if (!node || node.type !== ENTITY_TYPE) throw new Error(`no entity ${device}/${entity}`);
  const settable = SETTABLE_KINDS.includes(node.attrs.kind) && await cmd.sys.vfs.exists(cmd.access, `${entityPath(device, entity)}/${SET_NAME}`);
  return entitySummary(device, { name: entity, attrs: node.attrs, settable });
};

/** A value as a person writes it, as text: `21.5`, `on`, `true`. */
export const valueText = (value: Value): string => value === null ? '-' : value === true ? 'on' : value === false ? 'off' : String(value);
