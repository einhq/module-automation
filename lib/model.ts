/**
 * The sink: what the sources say, made nodes and messages on the bus.
 *
 * A device is a `device` node under the devices root, an entity an `entity` node under it with its
 * `history` log, its `live` router and, when it can be set, its `set` node (`lib/paths.ts`). A
 * reading or a press is written to the entity's `live` router, which publishes it on the entity's
 * routing key; the history log is bound to that key and so keeps it, and so does any queue anyone
 * binds to it. Nodes are written when a device or an entity is announced or changes, never per
 * reading.
 *
 * Updates are applied one at a time, in the order they came.
 */

import { type Command, readTail, type ResourceHandleIf } from '@ein/client';
import type { DeviceAttrs, EntityAttrs, EntityKind, OnlineMessage, Reading, Value } from './api.ts';
import { DEVICE_TYPE, devicePath, DEVICES_ROOT, ENTITY_TYPE, entityKey, entityPath, HISTORY_NAME, LIVE_NAME, ONLINE_NAME, onlineKey, SET_NAME, SET_TYPE } from './paths.ts';
import type { DeviceUpdate, EntityUpdate, Update } from './sources/types.ts';
import { decide, type Published } from './throttle.ts';

const encoder = new TextEncoder();

type SinkOptions = {
  cmd: Command;
  /** The history logs' retention: `365 day`, `forever`, `1000 entries`. */
  retention: string;
  /** Shortest time between two published numbers of one entity. */
  minIntervalMs: number;
  /** The group devices belong to, whose members may change them. */
  automationGid?: number;
  /** The group whose members may set an entity. */
  usersGid?: number;
};

type EntityState = {
  kind: EntityKind;
  unit?: string;
  minIntervalMs: number;
  live?: ResourceHandleIf;
  last?: Published;
  seeded: boolean;
  pending?: { value: Value; retained: boolean; timer: ReturnType<typeof setTimeout> };
};

const defined = <T extends Record<string, unknown>>(record: T): Partial<T> =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as Partial<T>;

/** Whether `patch` would change any of `attrs`. */
const changes = (attrs: Record<string, unknown>, patch: Record<string, unknown>): boolean =>
  Object.entries(patch).some(([key, value]) => JSON.stringify(attrs[key]) !== JSON.stringify(value));

export class Sink {
  private readonly devices = new Map<string, DeviceAttrs>();
  private readonly entities = new Map<string, EntityState>();
  private readonly online = new Map<string, ResourceHandleIf>();
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: SinkOptions) {}

  private get cmd(): Command {
    return this.options.cmd;
  }

  /** Apply an update from the source named `source`, after those before it. */
  apply(update: Update, source: string): Promise<void> {
    this.chain = this.chain.then(() => this.applyNow(update, source)).catch(async (error) => {
      await this.cmd.writeError(`automation: ${update.kind} ${'device' in update ? update.device : ''}: ${error instanceof Error ? error.message : error}\n`).catch(() => {});
    });
    return this.chain;
  }

  deviceCount(): number {
    return this.devices.size;
  }

  entityCount(): number {
    return this.entities.size;
  }

  /** The last value published for an entity. */
  current(device: string, entity: string): Value | undefined {
    return this.entities.get(`${device}/${entity}`)?.last?.value;
  }

  /** Let go of a device: what waits for it is dropped and its handles closed. */
  forget(device: string): Promise<void> {
    this.chain = this.chain.then(async () => {
      for (const [key, state] of [...this.entities]) {
        if (!key.startsWith(`${device}/`)) continue;
        if (state.pending) clearTimeout(state.pending.timer);
        await state.live?.close().catch(() => {});
        this.entities.delete(key);
      }
      await this.online.get(device)?.close().catch(() => {});
      this.online.delete(device);
      this.devices.delete(device);
    });
    return this.chain;
  }

  /** Publish what waits, and let go of every handle. */
  async close(): Promise<void> {
    await this.chain;
    this.closed = true;
    for (const [key, state] of this.entities) {
      if (state.pending) {
        clearTimeout(state.pending.timer);
        const [device, entity] = key.split('/');
        await this.write(device, entity, state, state.pending.value, state.pending.retained).catch(() => {});
        state.pending = undefined;
      }
      await state.live?.close().catch(() => {});
      state.live = undefined;
    }
    for (const handle of this.online.values()) await handle.close().catch(() => {});
    this.online.clear();
  }

  private async applyNow(update: Update, source: string): Promise<void> {
    if (this.closed) return;
    switch (update.kind) {
      case 'device':
        return await this.ensureDevice(update, source);
      case 'entity':
        return await this.ensureEntity(update, source);
      case 'state':
        return await this.state(update.device, update.entity, update.value, update.retained);
      case 'event':
        return await this.event(update.device, update.entity, update.value);
      case 'online':
        return await this.setOnline(update.device, update.online);
      case 'retire':
        return await this.retire(update.device, update.entity);
    }
  }

  private async ensureDevice(update: DeviceUpdate, source: string): Promise<void> {
    const { vfs } = this.cmd.sys;
    const path = devicePath(update.device);
    let attrs = this.devices.get(update.device);
    if (!attrs) {
      const node = await vfs.get<DeviceAttrs>(this.cmd.access, path).catch(() => undefined);
      if (!node) {
        attrs = defined({
          label: update.label,
          source,
          manufacturer: update.manufacturer,
          model: update.model,
          sw: update.sw,
          mac: update.mac,
        }) as DeviceAttrs;
        await vfs.createTree(this.cmd.access, DEVICES_ROOT, [{
          type: DEVICE_TYPE,
          name: update.device,
          props: defined({ gid: this.options.automationGid, mode: 0o775 }),
          attrs,
          children: [{ type: 'router', name: ONLINE_NAME, attrs: { routingKey: onlineKey(update.device) } }],
        }]);
        this.devices.set(update.device, attrs);
        return;
      }
      attrs = node.attrs;
      this.devices.set(update.device, attrs);
    }
    // The label is the device's own only until someone names it: a source's later word does not
    // replace it.
    const patch = defined({ source, manufacturer: update.manufacturer, model: update.model, sw: update.sw, mac: update.mac });
    if (!changes(attrs, patch)) return;
    const node = await vfs.update<DeviceAttrs>(this.cmd.access, path, { attrs: patch });
    this.devices.set(update.device, node.attrs);
  }

  private async ensureEntity(update: EntityUpdate, source: string): Promise<void> {
    const { vfs } = this.cmd.sys;
    const key = `${update.device}/${update.entity}`;
    const path = entityPath(update.device, update.entity);
    if (!this.devices.has(update.device)) {
      await this.ensureDevice({ kind: 'device', device: update.device, label: update.device }, source);
    }
    const routingKey = entityKey(update.device, update.entity, update.entityKind);
    const attrs = defined({
      kind: update.entityKind,
      unit: update.unit,
      deviceClass: update.deviceClass,
      category: update.category,
      options: update.options,
      min: update.min,
      max: update.max,
      supported: update.supported,
    }) as Partial<EntityAttrs>;
    const node = await vfs.get<EntityAttrs>(this.cmd.access, path).catch(() => undefined);
    if (!node) {
      await vfs.createTree(this.cmd.access, devicePath(update.device), [{
        type: ENTITY_TYPE,
        name: update.entity,
        attrs: { label: update.label, ...attrs },
        children: [
          { type: 'log', name: HISTORY_NAME, attrs: defined({ retention: this.options.retention, routingKeys: [routingKey], unit: update.unit }) },
          { type: 'router', name: LIVE_NAME, attrs: { routingKey } },
          ...(update.settable ? [{ type: SET_TYPE, name: SET_NAME, props: defined({ gid: this.options.usersGid, mode: 0o660 }), attrs: {} }] : []),
        ],
      }]);
    } else {
      const was = node.attrs;
      if (changes(was, { ...attrs, retired: undefined })) {
        await vfs.update<EntityAttrs>(this.cmd.access, path, { attrs: { ...attrs, retired: null } as never });
      }
      if (was.kind !== update.entityKind || was.unit !== update.unit) {
        await vfs.update(this.cmd.access, `${path}/${HISTORY_NAME}`, { attrs: { routingKeys: [routingKey], unit: update.unit ?? null } as never });
        await vfs.update(this.cmd.access, `${path}/${LIVE_NAME}`, { attrs: { routingKey } });
        await this.entities.get(key)?.live?.close().catch(() => {});
      }
      if (update.settable && !(await vfs.exists(this.cmd.access, `${path}/${SET_NAME}`))) {
        await vfs.create(this.cmd.access, SET_TYPE, path, SET_NAME, { props: defined({ gid: this.options.usersGid, mode: 0o660 }), attrs: {} });
      }
    }
    const state = this.entities.get(key);
    const minIntervalMs = typeof node?.attrs.minInterval === 'number' ? node.attrs.minInterval * 1000 : this.options.minIntervalMs;
    if (state) {
      state.kind = update.entityKind;
      state.unit = update.unit;
      state.minIntervalMs = minIntervalMs;
      if (node && node.attrs.kind !== update.entityKind) state.live = undefined;
    } else {
      this.entities.set(key, { kind: update.entityKind, unit: update.unit, minIntervalMs, seeded: false });
    }
  }

  private async state(device: string, entity: string, value: Value, retained: boolean): Promise<void> {
    const state = this.entities.get(`${device}/${entity}`);
    if (!state) return;
    if (!state.seeded) {
      // The last value kept, so a broker's replay after a restart publishes nothing new.
      const [last] = await readTail<Reading>(this.cmd.sys.vfs, this.cmd.access, `${entityPath(device, entity)}/${HISTORY_NAME}`, 1);
      if (last && last.value && 'value' in last.value) state.last = { value: last.value.value, at: last.at };
      state.seeded = true;
    }
    const now = Date.now();
    const decision = decide(state.last, value, now, state.minIntervalMs);
    if (decision.publish === 'no') {
      if (state.pending) clearTimeout(state.pending.timer);
      state.pending = undefined;
      return;
    }
    if (decision.publish === 'now') {
      if (state.pending) clearTimeout(state.pending.timer);
      state.pending = undefined;
      await this.write(device, entity, state, value, retained);
      return;
    }
    if (state.pending) {
      state.pending.value = value;
      state.pending.retained = retained;
      return;
    }
    const timer = setTimeout(() => {
      const pending = state.pending;
      state.pending = undefined;
      if (pending) this.apply({ kind: 'state', device, entity, value: pending.value, retained: pending.retained }, '');
    }, decision.at - now);
    state.pending = { value, retained, timer };
  }

  private async event(device: string, entity: string, value: string): Promise<void> {
    const state = this.entities.get(`${device}/${entity}`);
    if (!state) return;
    await this.write(device, entity, state, value, false);
  }

  private async write(device: string, entity: string, state: EntityState, value: Value, retained: boolean): Promise<void> {
    const reading: Reading = {
      device,
      entity,
      kind: state.kind === 'button' ? 'event' : 'state',
      value,
      ...(state.unit ? { unit: state.unit } : {}),
      at: new Date().toISOString(),
      ...(retained ? { retained: true as const } : {}),
    };
    const line = encoder.encode(JSON.stringify(reading) + '\n');
    state.live ??= await this.cmd.sys.vfs.open(this.cmd.access, `${entityPath(device, entity)}/${LIVE_NAME}`, { mode: 'a' });
    await state.live.write(line);
    state.last = { value, at: Date.now() };
  }

  private async setOnline(device: string, online: boolean): Promise<void> {
    const attrs = this.devices.get(device);
    if (!attrs) return;
    if (attrs.online !== online) {
      const node = await this.cmd.sys.vfs.update<DeviceAttrs>(this.cmd.access, devicePath(device), { attrs: { online } });
      this.devices.set(device, node.attrs);
    }
    let handle = this.online.get(device);
    if (!handle) {
      handle = await this.cmd.sys.vfs.open(this.cmd.access, `${devicePath(device)}/${ONLINE_NAME}`, { mode: 'a' });
      this.online.set(device, handle);
    }
    const message: OnlineMessage = { device, online, at: new Date().toISOString() };
    await handle.write(encoder.encode(JSON.stringify(message) + '\n'));
  }

  private async retire(device: string, entity: string): Promise<void> {
    const path = entityPath(device, entity);
    if (!(await this.cmd.sys.vfs.exists(this.cmd.access, path))) return;
    await this.cmd.sys.vfs.update<EntityAttrs>(this.cmd.access, path, { attrs: { retired: true } });
  }
}
