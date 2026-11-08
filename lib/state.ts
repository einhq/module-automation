/**
 * The running bridge, as the other commands of this process see it.
 *
 * A module's lib file is staged once per process, so this module's state is shared by the bridge
 * and every command that imports it: `automation-status` reads it, and `device-set` asks it to
 * send. There is at most one bridge per process; nothing here is persisted.
 */

import type { Value } from './api.ts';

export type BridgeState = {
  url: string;
  sources: string[];
  connected: boolean;
  since: number;
  messages: number;
  lastError?: string;
  /** Entities the bridge cannot read, as `<device>/<entity>: why`. */
  notes(): string[];
  devices(): number;
  entities(): number;
  /** The last value published for an entity, for a toggle to know which way to go. */
  current(device: string, entity: string): Value | undefined;
  /** Let go of a device, and tell the broker to stop replaying its announcements. */
  forget(device: string): Promise<void>;
};

let running: BridgeState | undefined;

export const bridgeState = (): BridgeState | undefined => running;

export const setBridgeState = (state: BridgeState | undefined): void => {
  running = state;
};

/** The running rules service, as the other commands of this process see it. */
type RulesState = {
  rules(): number;
  /** Rule files that are not run, as `<name>: why`. */
  problems(): string[];
  runs: number;
};

let rulesRunning: RulesState | undefined;

export const rulesState = (): RulesState | undefined => rulesRunning;

export const setRulesState = (state: RulesState | undefined): void => {
  rulesRunning = state;
};
