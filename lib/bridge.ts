/**
 * The bridge: one MQTT connection, the sources listening on it, and the device writer they feed.
 * It connects, subscribes to what each source listens on and to every topic a source asked for
 * since, and hands each message to every source. When the connection is lost it connects again,
 * waiting 1 s, then twice as long each time up to a minute, so a broker that is away never ends
 * the service.
 *
 * Each source is registered with core as the driver of the devices it finds, for as long as the
 * bridge runs. A value written to one of their controls (`echo on > /dev/hall-plug/switch-0`),
 * which core has checked against the control's schema and the writer's rights, is sent to the
 * device as its source says it; the device's report of its new state comes back as a reading. A
 * write while the broker is away is refused, not kept: a lamp switched on an hour after it was
 * asked would surprise.
 */

import type { Command, Driver, ModuleDevices } from '@ein/client';
import { commandValue, type DeviceWriter } from './drivers.ts';
import type { MqttConnect, MqttConnection, MqttMessage } from './mqtt.ts';
import type { Publish, RunningSource, Update } from './sources/mod.ts';
import { type BridgeState, setBridgeState } from './state.ts';

type BridgeOptions = {
  cmd: Command;
  url: string;
  connect: MqttConnect;
  sources: RunningSource[];
  devices: ModuleDevices;
  writer: DeviceWriter;
  /** Resolves when the bridge is to stop. */
  stopped: Promise<void>;
};

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const runBridge = async (options: BridgeOptions): Promise<void> => {
  const { cmd, sources, writer, stopped } = options;
  const log = (line: string) => cmd.writeLn(`automation-bridge: ${line}`).catch(() => {});
  let stopping = false;
  stopped.then(() => stopping = true);

  /** Topics the sources asked for after the start, subscribed again on every connection. */
  const asked = new Set<string>();
  const base = [...new Set(sources.flatMap((source) => source.topics()))];
  let connection: MqttConnection | undefined;

  const state: BridgeState = {
    url: options.url,
    drivers: sources.map((source) => source.name),
    connected: false,
    since: Date.now(),
    messages: 0,
    notes: () => sources.flatMap((source) => source.notes?.() ?? []),
  };
  setBridgeState(state);

  const send = async (publish: Publish): Promise<void> => {
    if (!connection) throw new Error('not connected to the broker, so nothing was sent');
    await connection.publish(publish.topic, publish.payload, { retain: publish.retain });
  };

  const driverOf = (source: RunningSource): Driver => ({
    description: source.description,
    module: 'automation',
    write: async ({ device, endpoint, value, by }) => {
      const publishes = source.encode({ device, entity: endpoint, value: commandValue(value) });
      if (!publishes?.length) throw new Error(`${source.name} has not heard how ${device}/${endpoint} is set`);
      for (const publish of publishes) await send(publish);
      log(`${device}/${endpoint} set to ${commandValue(value)} by ${by}`);
    },
    forget: async (device) => {
      for (const publish of source.forget(device)) await send(publish).catch((error) => log(`clearing ${publish.topic}: ${message(error)}`));
      await writer.forget(device);
    },
  });
  const unregister = sources.map((source) => options.devices.registerDriver(source.name, driverOf(source)));

  const handle = (update: Update, source: RunningSource) => {
    if (update.kind === 'subscribe') {
      if (asked.has(update.topic) || base.includes(update.topic)) return;
      asked.add(update.topic);
      connection?.subscribe([update.topic]).catch((error) => log(`subscribing to ${update.topic}: ${message(error)}`));
    } else if (update.kind === 'publish') {
      send(update.publish).catch((error) => log(`sending to ${update.publish.topic}: ${message(error)}`));
    } else {
      writer.apply(update, source.name);
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

  let backoff = MIN_BACKOFF_MS;
  await log(`drivers ${state.drivers.join(', ')}; connecting to ${options.url}`);
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

  for (const each of unregister) each();
  await writer.close();
  setBridgeState(undefined);
  await log('stopped');
};
