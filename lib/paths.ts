/**
 * Where automation keeps its rules, and the routing keys the rules service reads.
 */

/** The group whose members write rules. */
export const AUTOMATION_GROUP = 'automation';

/** Rules, one YAML file each, written by members of the automation group. */
export const RULES_DIR = '/etc/automation/rules';
/** Each run of a rule: what made it run and how each of its lines ended. */
export const RULES_LOG = '/var/logs/automation/rules';
/** The bus messages the rules service reads, kept while it is down. */
export const RULES_QUEUE = '/var/queues/automation-rules';
/** Every device's readings, presses and coming and going, as core's devices publish them. */
export const RULES_KEYS = ['dev.#'];
