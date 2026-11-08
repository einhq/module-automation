/**
 * The running bridge and rules service, as the other commands of this process see them.
 *
 * A module's lib file is staged once per process, so this module's state is shared by the services
 * and every command that imports it: `automation-status` reads it. There is at most one bridge and
 * one rules service per process; nothing here is persisted.
 */

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
