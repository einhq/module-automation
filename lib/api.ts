/**
 * The answers of automation's commands, for other modules (`@automation/api`). Import-free on
 * purpose: a page imports it without pulling in the module's commands.
 */

/** `automation-status`: the bridge and its drivers, as this process sees them, and the rules. */
export type AutomationStatus = {
  /** False when the broker address is unset: automation is off. */
  configured: boolean;
  url?: string;
  /** Whether the bridge runs in this process. */
  running: boolean;
  connected: boolean;
  /** Since when it has been connected, or disconnected. */
  since?: string;
  /** The drivers the bridge has registered with core, one per source it listens with: `ha-discovery`, `shelly`. */
  drivers: string[];
  /** The devices under /dev that automation's drivers drive, as the caller sees them. */
  devices: number;
  /** Their endpoints. */
  endpoints: number;
  /** MQTT messages heard since the bridge started. */
  messages: number;
  /** What the drivers cannot read, as `<device>/<entity>: why`. */
  unsupported: string[];
  lastError?: string;
  /** The rules service, when it runs in this process. */
  rules?: { count: number; runs: number; problems: string[] };
};

/** `automation-rule-check`: a rule file as the rules service reads it, and what its conditions say now. */
export type RuleCheck = {
  name: string;
  path: string;
  /** The account its lines run as. */
  owner: string;
  /** Why the service does not run it. */
  problem?: string;
  description?: string;
  when?: string[];
  if?: { condition: string; holds: boolean }[];
  then?: string[];
  /** With `--run`: each line run, as the caller, until one failed. */
  ran?: { line: string; code: number }[];
};
