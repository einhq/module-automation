/**
 * The sources the bridge can run, by name (`CFG_AUTOMATION_SOURCES`). Each is a driver of core's
 * by the same name while the bridge runs.
 */

import { createHaDiscovery } from './ha-discovery.ts';
import { createShelly } from './shelly.ts';
import type { MqttSource } from './types.ts';

export type { Command, DeviceChange, DeviceUpdate, EntityUpdate, MqttSource, Publish, Update } from './types.ts';

/** Every source there is, which are the names of automation's drivers. */
export const SOURCE_NAMES: readonly string[] = ['ha-discovery', 'shelly'];

type SourceOptions = {
  /** Home Assistant's discovery prefix. */
  discoveryPrefix: string;
  /** This bridge's own name on the broker, which Shelly answers to. */
  clientId: string;
};

/** A source and anything it has to say about what it could not read. */
export type RunningSource = MqttSource & { notes?(): string[] };

/** The named sources; names it does not know are left out and returned as `unknown`. */
export const createSources = (names: string[], options: SourceOptions): { sources: RunningSource[]; unknown: string[] } => {
  const sources: RunningSource[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    if (name === 'ha-discovery') sources.push(createHaDiscovery({ prefix: options.discoveryPrefix }));
    else if (name === 'shelly') sources.push(createShelly({ src: options.clientId }));
    else unknown.push(name);
  }
  return { sources, unknown };
};
