/**
 * The bridge: one MQTT connection, the sources listening on it, and the device writer they feed.
 * It connects, subscribes to what each source listens on and to every topic a source asked for
 * since, and hands each message to every source, except what the network listener says under
 * `ein/discovery/`, which it keeps as the hosts on the network `automation-found` names. When the
 * connection is lost it connects again, waiting 1 s, then twice as long each time up to a minute,
 * so a broker that is away never ends the service. Beside the sources it runs the polled drivers
 * (`network`, `ipp`, `snmp`, `cast`, `http`), which ask their devices themselves, and the cameras'
 * driver (`rtsp`); without a broker (`connect` unset) it runs those alone.
 *
 * Each source is registered with core as the driver of the devices it finds, for as long as the
 * bridge runs. A value written to one of their controls (`echo on > /dev/hall-plug/switch-0`),
 * which core has checked against the control's schema and the writer's rights, is sent to the
 * device as its source says it; the device's report of its new state comes back as a reading. A
 * write while the broker is away is refused, not kept: a lamp switched on an hour after it was
 * asked would surprise.
 */

import type { Command, Driver, ModuleDevices } from '@ein/client';
import { RTSP_DRIVER, startCameras } from './cameras/rtsp.ts';
import type { Restreamer } from './cameras/restreamer.ts';
import { commandValue, type DeviceWriter } from './drivers.ts';
import type { MqttConnect, MqttConnection, MqttMessage } from './mqtt.ts';
import { NetworkHosts } from './network/found.ts';
import type { PolledDriver } from './network/polled.ts';
import { startPoller } from './network/poller.ts';
import type { Publish, RunningSource, Update } from './sources/mod.ts';
import { type BridgeState, setBridgeState } from './state.ts';

type BridgeOptions = {
  cmd: Command;
  /** The broker's address; empty without one. */
  url: string;
  /** Unset without a broker: then only the polled drivers run. */
  connect?: MqttConnect;
  sources: RunningSource[];
  /** The drivers that ask devices on the network themselves, run beside the sources. */
  polled: PolledDriver[];
  /** Where the cameras' streams are given; unset when none is set. */
  restreamer?: Restreamer;
  /** What the cameras' still pictures are fetched with when there is no restreamer. */
  fetcher: typeof fetch;
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
  const network = new NetworkHosts();
  const base = [...new Set([...sources.flatMap((source) => source.topics()), ...network.topics()])];
  let connection: MqttConnection | undefined;

  const state: BridgeState = {
    url: options.url,
    drivers: [...sources.map((source) => source.name), ...options.polled.map((driver) => driver.name), RTSP_DRIVER],
    connected: false,
    since: Date.now(),
    messages: 0,
    notes: () => sources.flatMap((source) => source.notes?.() ?? []),
    network,
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
  const poller = startPoller({ cmd, devices: options.devices, writer, network, drivers: options.polled, log: (line) => log(line) });
  state.pollNow = poller.pollNow;
  const stopCameras = startCameras({ cmd, devices: options.devices, restreamer: options.restreamer, fetcher: options.fetcher, log: (line) => log(line) });

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
    if (network.hear(received.topic, received.payload)) return;
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
  const connect = options.connect;
  if (connect) {
    await log(`drivers ${state.drivers.join(', ')}; connecting to ${options.url}`);
  } else {
    await log(`drivers ${state.drivers.join(', ')}; no broker set, so only the devices asked over the network are read`);
    await stopped;
  }
  while (connect && !stopping) {
    try {
      connection = await connect(onMessage);
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
  poller.stop();
  stopCameras();
  await writer.close();
  setBridgeState(undefined);
  await log('stopped');
};
