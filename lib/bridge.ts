/**
 * The bridge: one MQTT connection, the sources listening on it, and the sink they feed. It
 * connects, subscribes to what each source listens on and to every topic a source asked for
 * since, and hands each message to every source. When the connection is lost it connects again,
 * waiting 1 s, then twice as long each time up to a minute, so a broker that is away never ends
 * the service.
 *
 * A command is a write to an entity's `set` node (`device-set`), which the VFS checks against the
 * writer's rights. The bridge follows those writes in this process and sends what the entity's
 * source makes of them. A command given while the broker is away is dropped, not kept: a lamp
 * switched on an hour after it was asked would surprise.
 */

import type { Command, NodeEvent } from '@ein/client';
import type { SetAttrs } from './api.ts';
import type { Sink } from './model.ts';
import type { MqttConnect, MqttConnection, MqttMessage } from './mqtt.ts';
import { DEVICES_ROOT, parseTarget, SET_NAME, SET_TYPE } from './paths.ts';
import type { Publish, RunningSource, Update } from './sources/mod.ts';
import { type BridgeState, setBridgeState } from './state.ts';

type BridgeOptions = {
  cmd: Command;
  url: string;
  connect: MqttConnect;
  sources: RunningSource[];
  sink: Sink;
  /** Resolves when the bridge is to stop. */
  stopped: Promise<void>;
};

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const runBridge = async (options: BridgeOptions): Promise<void> => {
  const { cmd, sources, sink, stopped } = options;
  const log = (line: string) => cmd.writeLn(`automation-bridge: ${line}`).catch(() => {});
  let stopping = false;
  stopped.then(() => stopping = true);

  /** Topics the sources asked for after the start, subscribed again on every connection. */
  const asked = new Set<string>();
  const base = [...new Set(sources.flatMap((source) => source.topics()))];
  let connection: MqttConnection | undefined;

  const state: BridgeState = {
    url: options.url,
    sources: sources.map((source) => source.name),
    connected: false,
    since: Date.now(),
    messages: 0,
    notes: () => sources.flatMap((source) => source.notes?.() ?? []),
    devices: () => sink.deviceCount(),
    entities: () => sink.entityCount(),
    current: (device, entity) => sink.current(device, entity),
    forget: async (device) => {
      for (const source of sources) {
        for (const publish of source.forget(device)) await send(publish).catch((error) => log(`clearing ${publish.topic}: ${message(error)}`));
      }
      await sink.forget(device);
    },
  };
  setBridgeState(state);

  const send = async (publish: Publish): Promise<void> => {
    if (!connection) throw new Error('not connected to the broker');
    await connection.publish(publish.topic, publish.payload, { retain: publish.retain });
  };

  const handle = (update: Update, source: RunningSource) => {
    if (update.kind === 'subscribe') {
      if (asked.has(update.topic) || base.includes(update.topic)) return;
      asked.add(update.topic);
      connection?.subscribe([update.topic]).catch((error) => log(`subscribing to ${update.topic}: ${message(error)}`));
    } else if (update.kind === 'publish') {
      send(update.publish).catch((error) => log(`sending to ${update.publish.topic}: ${message(error)}`));
    } else {
      sink.apply(update, source.name);
    }
  };

  const onMessage = (received: MqttMessage) => {
    state.messages++;
    for (const source of sources) {
      let updates: Update[];
      try {
        updates = source.decode(received.topic, received.payload, received.retained);
      } catch (error) {
        log(`${source.name} could not read ${received.topic}: ${message(error)}`);
        continue;
      }
      for (const update of updates) handle(update, source);
    }
  };

  const onSet = (event: NodeEvent<SetAttrs>) => {
    const target = parseTarget(event.path.slice(0, -`/${SET_NAME}`.length));
    const value = event.node.attrs.value;
    if (!target?.entity || typeof value !== 'string' || event.node.attrs.id === event.previousNode?.attrs.id) return;
    const { device, entity } = target;
    const source = sources.find((each) => each.owns(device));
    const publishes = source?.encode({ device, entity, value, current: sink.current(device, entity) });
    if (!publishes?.length) {
      log(`${device}/${entity} cannot be set to ${value}: no source of this bridge sets it`);
      return;
    }
    log(`${device}/${entity} set to ${value} by uid ${event.uid}`);
    for (const publish of publishes) send(publish).catch((error) => log(`${device}/${entity} not set: ${message(error)}`));
  };

  const subscription = await cmd.sys.vfs.subscribe<SetAttrs>?.(() => cmd.access, onSet, { pathPrefix: DEVICES_ROOT, nodeTypes: [SET_TYPE], eventTypes: ['updated'] });
  if (!subscription) await log('this store tells no one of writes: device-set does nothing');

  let backoff = MIN_BACKOFF_MS;
  await log(`sources ${state.sources.join(', ')}; connecting to ${options.url}`);
  while (!stopping) {
    try {
      connection = await options.connect(onMessage);
      state.connected = true;
      state.since = Date.now();
      state.lastError = undefined;
      await log('connected');
      await connection.subscribe([...base, ...asked]);
      backoff = MIN_BACKOFF_MS;
      await Promise.race([connection.closed, stopped]);
      if (!stopping) await log('the broker closed the connection');
    } catch (error) {
      state.lastError = message(error);
      await log(`cannot connect: ${state.lastError}`);
    }
    if (state.connected) state.since = Date.now();
    state.connected = false;
    await connection?.close().catch(() => {});
    connection = undefined;
    if (stopping) break;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([stopped, new Promise((resolve) => timer = setTimeout(resolve, backoff))]);
    clearTimeout(timer);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }

  await subscription?.unsubscribe().catch(() => {});
  await sink.close();
  setBridgeState(undefined);
  await log('stopped');
};
