/**
 * The running bridge and automation engine, as the other commands of this process see them.
 *
 * A module's lib file is staged once per process, so this module's state is shared by the services
 * and every command that imports it: `automation-status` reads it. There is at most one bridge and
 * one engine per process; nothing here is persisted.
 */

import type { AutomationNodeStatus, AutomationProblem } from './api.ts';
import type { NetworkHosts } from './network/found.ts';

export type BridgeState = {
  url: string;
  /** The drivers it registered, one per source. */
  drivers: string[];
  connected: boolean;
  since: number;
  messages: number;
  lastError?: string;
  /** Entities the drivers cannot read, as `<device>/<entity>: why`. */
  notes(): string[];
  /** What the network listener heard, on the same broker. */
  network: NetworkHosts;
  /** Ask a device of a polled driver now; set once the poller runs. */
  pollNow?(device: string): void;
};

let running: BridgeState | undefined;

export const bridgeState = (): BridgeState | undefined => running;

export const setBridgeState = (state: BridgeState | undefined): void => {
  running = state;
};

/** The running automation engine, as the other commands of this process see it. */
type EngineState = {
  /** Each automation it read, by name: whether it runs it, and why not. */
  known(): Map<string, { running: boolean; problems: AutomationProblem[] }>;
  /** What each node of a running automation last did. */
  status(name: string): Record<string, AutomationNodeStatus> | undefined;
  /** Press a button node of a running automation; throws when there is none. */
  press(name: string, node: string): void;
  /** Actions taken since it started. */
  actions: number;
  /** Read the automations again now, rather than once their files have settled. */
  reload(): Promise<void>;
};

let engineRunning: EngineState | undefined;

export const engineState = (): EngineState | undefined => engineRunning;

export const setEngineState = (state: EngineState | undefined): void => {
  engineRunning = state;
};
