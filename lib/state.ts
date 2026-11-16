/**
 * The running automation engine, as the other commands of this process see it.
 *
 * A module's lib file is staged once per process, so this module's state is shared by the service
 * and every command that imports it: `automation-status` reads it. There is at most one engine per
 * process; nothing here is persisted.
 */

import type { AutomationNodeStatus, AutomationProblem } from './api.ts';

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
