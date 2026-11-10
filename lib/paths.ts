/**
 * Where automation keeps its automations and what they need, and the routing keys its engine reads.
 */

/** The group whose members write automations. */
export const AUTOMATION_GROUP = 'automation';

/** People's automations, one YAML file each (`<name>.yaml`), written by members of the automation group. */
export const AUTOMATIONS_DIR = '/etc/automations';
/** Modules' automations: `mod setup` links a module's `etc/automations.d` here as `<module>/`. */
export const MODULE_AUTOMATIONS_DIR = '/etc/automations.d';
/** Each automation's run log: its actions, errors, debug nodes and clock firings, its owner's alone. */
export const RUN_LOGS_DIR = '/var/logs/automations';
/** A module automation's run log, under its module's name. */
export const MODULE_RUN_LOGS_DIR = '/var/logs/automations.d';
/** What each automation waits for (its timers' deadlines), kept over a restart. */
export const STATE_DIR = '/var/lib/automations';
export const MODULE_STATE_DIR = '/var/lib/automations.d';
/** The bus messages the engine reads, kept while it is down. */
export const AUTOMATIONS_QUEUE = '/var/queues/automations';
/** Every device's readings, presses and coming and going, as core's devices publish them. */
export const AUTOMATIONS_KEYS = ['dev.#'];
/**
 * EiN's events the engine reads, apart from the devices' so that a flood of them (an import) does
 * not hold up a press; bound only to what running automations listen for.
 */
export const AUTOMATION_EVENTS_QUEUE = '/var/queues/automation-events';
/** The hosts on the network no one wants as devices, one id (`automation-found`) a line. */
export const NETWORK_IGNORED = '/etc/automation/network-ignored';
