/**
 * The answers of automation's commands, for other modules (`@automation/api`). Import-free on
 * purpose: a page imports it without pulling in the module's commands.
 */

/** `automation-status`: the automation engine, as this process sees it. */
export type AutomationStatus = {
  /** Whether the engine runs in this process. */
  running: boolean;
  /** How many automations it runs. */
  automations: number;
  /** Actions taken since it started. */
  actions: number;
  /** The automations it holds back, as `<name>: why`. */
  problems: string[];
};

/** What an automation's messages carry: a device's reading, a word, a number. */
export type AutomationValue = number | string | boolean | null;

/** One node of an automation as its YAML says it: its kind, its settings, where it is and where it sends. */
export type AutomationNodeSpec = {
  type: string;
  label?: string;
  /** Its place on the canvas, `[x, y]`. */
  pos?: [number, number];
  /** The nodes it sends to: a list for its `out`, or a list per output (`true`, `false`, a switch's cases). */
  to?: string[] | Record<string, string[]>;
  [setting: string]: unknown;
};

/** An automation as its YAML says it. */
export type AutomationSpec = {
  description?: string;
  /** False to keep it from running; an `enabled` attr on its file says so too, and wins. */
  enabled?: boolean;
  nodes: Record<string, AutomationNodeSpec>;
};

/** What is wrong with an automation, and in which node. */
export type AutomationProblem = { node?: string; message: string };

/** What one node of a running automation last did. */
export type AutomationNodeStatus = {
  /** What it last sent. */
  value?: AutomationValue;
  /** When. */
  at?: string;
  /** What it last sent on each output, and when: a wire's last message. */
  outputs?: Record<string, { value: AutomationValue; at: string }>;
  /** When it will send next by itself: a timer's end, a delay's, a held value's. */
  due?: string;
  /** Why it did not do what it should: an action that failed, a value it waits for. */
  problem?: string;
  /** Messages that came to it. */
  messages: number;
};

/** `automations`: an automation, whose it is, whether it runs, and what is wrong with it. */
export type AutomationSummary = {
  /** `<name>`, or `<module>/<name>` for a module's. */
  name: string;
  path: string;
  /** The module it came with; a module's runs as the administrator and is not changed in place. */
  module?: string;
  /** The account it runs as. */
  owner: string;
  description?: string;
  enabled: boolean;
  /** Whether the engine runs it now. */
  running: boolean;
  nodes: number;
  /** Why it does not run: its own problems, or the engine's (an endpoint its owner may not read). */
  problems: AutomationProblem[];
  /** Whether the caller may change it. */
  writable: boolean;
};

/** `automation-show`: an automation's file, and its graph with every node placed. */
export type AutomationDetail = AutomationSummary & {
  /** The YAML as the file has it. */
  text: string;
  /** Its parsed YAML, a node without `pos` given one; absent when it is not YAML. */
  spec?: AutomationSpec;
  /** The names of its own scripts, the files under `<file>/scripts/`, that the caller may see. */
  scripts: string[];
};

/** `automation-set` and `automation-new`: whether it was written, and what is wrong with it. */
export type AutomationSetAnswer = { name: string; path: string; written: boolean; created: boolean; problems: AutomationProblem[] };

/** `automation-status <name>`: what each node of a running automation last did. */
export type AutomationRunStatus = { name: string; running: boolean; problems: AutomationProblem[]; nodes: Record<string, AutomationNodeStatus> };

/** `automation-check`: what is wrong with an automation, and what each node would say now, read as the caller. */
export type AutomationCheck = {
  name?: string;
  problems: AutomationProblem[];
  /** Each node's state after the latest readings the caller may read went through it, no action run. */
  nodes: Record<string, AutomationNodeStatus>;
  /** The endpoints it reads and writes, and what the caller finds there. */
  endpoints: { endpoint: string; readable: boolean; value?: AutomationValue; at?: string }[];
};
