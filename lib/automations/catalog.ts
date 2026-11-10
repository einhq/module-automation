/**
 * The kinds of node an automation is made of: what each reads from its settings, whether it has an
 * input, and which outputs it sends on. The validator, the engine and the editor's palette and forms
 * all read this; nothing else says what a kind takes.
 *
 * Import-free but for its own module's files, so a page imports it as the engine does.
 */

import { AGGREGATES } from './values.ts';

type SettingType =
  /** `<device>/<endpoint>`. */
  | 'endpoint'
  /** A device's name. */
  | 'device'
  /** `30s`, `5m`, `1.5h`, `1d`. */
  | 'duration'
  | 'number'
  /** A reading or a word: `on`, `21.5`, `single`. */
  | 'value'
  | 'text'
  /** A time of day, `07:30`. */
  | 'time'
  /** Days of the week: `[mon, tue]`, `weekdays`, `weekends`. */
  | 'days'
  | 'flag'
  | 'choice'
  /** A math node's expression. */
  | 'expression'
  /** A shell command line. */
  | 'line'
  /** A switch's cases: `{cold: {below: 18}, warm: {above: 23}}`, each an output of its own. */
  | 'cases';

export type SettingSpec = {
  name: string;
  type: SettingType;
  label: string;
  required?: boolean;
  choices?: readonly string[];
  help?: string;
};

type NodeGroup = 'input' | 'logic' | 'value' | 'time' | 'action';

export type KindSpec = {
  type: string;
  group: NodeGroup;
  label: string;
  /** A Tabler icon's name. */
  icon: string;
  description: string;
  /** Whether wires may come in. */
  input: boolean;
  /**
   * Its outputs: `out` sends what it says; a node that says true or false also has `true` and
   * `false`, each sending only that. A switch's outputs are its cases and `else`.
   */
  outputs: readonly string[];
  /** It says true or false, and only when that changes, unless `every` is set. */
  boolean?: boolean;
  settings: readonly SettingSpec[];
};

/** Settings every node may have, beside its kind's. */
export const COMMON_KEYS = ['type', 'label', 'pos', 'to'] as const;

const BOOL = ['out', 'true', 'false'] as const;
const OUT = ['out'] as const;
const EVERY: SettingSpec = { name: 'every', type: 'flag', label: 'Send every result', help: 'Send each result, not only when it changes' };
const TESTS: SettingSpec[] = [
  { name: 'is', type: 'value', label: 'Is' },
  { name: 'not', type: 'value', label: 'Is not' },
  { name: 'above', type: 'number', label: 'Above' },
  { name: 'below', type: 'number', label: 'Below' },
];

const kinds: KindSpec[] = [
  {
    type: 'device',
    group: 'input',
    label: 'Device',
    icon: 'broadcast',
    description: "An endpoint's readings or presses",
    input: false,
    outputs: OUT,
    settings: [
      { name: 'endpoint', type: 'endpoint', label: 'Endpoint', required: true, help: 'hall-sensor/temperature, porch-button/input-0' },
      {
        name: 'is',
        type: 'value',
        label: 'Only when it is',
        help: 'Pass a reading or press on only when it is this, such as on, or single or long for a button. Left empty, every one is passed on.',
      },
    ],
  },
  {
    type: 'online',
    group: 'input',
    label: 'Online',
    icon: 'wifi',
    description: 'Whether a device is online',
    input: false,
    outputs: BOOL,
    boolean: true,
    settings: [{ name: 'device', type: 'device', label: 'Device', required: true }, EVERY],
  },
  {
    type: 'clock',
    group: 'input',
    label: 'Clock',
    icon: 'clock',
    description: 'At a time of day, or every so often',
    input: false,
    outputs: OUT,
    settings: [
      { name: 'at', type: 'time', label: 'At', help: '07:30, in the system time zone' },
      { name: 'days', type: 'days', label: 'Days', help: 'weekdays, weekends, or [mon, wed, fri]' },
      { name: 'every', type: 'duration', label: 'Every', help: '15m: a minute or more' },
    ],
  },
  {
    type: 'button',
    group: 'input',
    label: 'Button',
    icon: 'hand-finger',
    description: 'Pressed from the editor, or with automation-trigger',
    input: false,
    outputs: OUT,
    settings: [{ name: 'value', type: 'value', label: 'Sends', help: 'true unless set' }],
  },
  {
    type: 'link-in',
    group: 'input',
    label: 'Link in',
    icon: 'link',
    description: "What a link out of the same name sends, from any of its owner's automations",
    input: false,
    outputs: OUT,
    settings: [{ name: 'name', type: 'text', label: 'Name', required: true }],
  },
  {
    type: 'compare',
    group: 'logic',
    label: 'Compare',
    icon: 'math-greater',
    description: 'Whether the value is, is not, is above or below',
    input: true,
    outputs: BOOL,
    boolean: true,
    settings: [...TESTS, EVERY],
  },
  {
    type: 'and',
    group: 'logic',
    label: 'And',
    icon: 'logic-and',
    description: 'True while everything wired in is true',
    input: true,
    outputs: BOOL,
    boolean: true,
    settings: [EVERY],
  },
  {
    type: 'or',
    group: 'logic',
    label: 'Or',
    icon: 'logic-or',
    description: 'True while anything wired in is true',
    input: true,
    outputs: BOOL,
    boolean: true,
    settings: [EVERY],
  },
  {
    type: 'not',
    group: 'logic',
    label: 'Not',
    icon: 'logic-not',
    description: 'True when the value is false',
    input: true,
    outputs: BOOL,
    boolean: true,
    settings: [EVERY],
  },
  {
    type: 'switch',
    group: 'logic',
    label: 'Switch',
    icon: 'arrows-split',
    description: 'Sends the value on the first case it meets, else on else',
    input: true,
    outputs: ['else'],
    settings: [{ name: 'cases', type: 'cases', label: 'Cases', required: true, help: 'cold: {below: 18}, warm: {above: 23}' }],
  },
  {
    type: 'math',
    group: 'value',
    label: 'Math',
    icon: 'math-function',
    description: 'A value worked out from the value and what else is wired in',
    input: true,
    outputs: OUT,
    settings: [{ name: 'expression', type: 'expression', label: 'Expression', required: true, help: 'value * 1.8 + 32, round(value, 1), outdoor - indoor' }],
  },
  {
    type: 'aggregate',
    group: 'value',
    label: 'Aggregate',
    icon: 'math-avg',
    description: 'The average, least, most, sum or count of what is wired in',
    input: true,
    outputs: OUT,
    settings: [{ name: 'fn', type: 'choice', label: 'Of', required: true, choices: AGGREGATES }, EVERY],
  },
  {
    type: 'set',
    group: 'value',
    label: 'Set',
    icon: 'pencil',
    description: 'Sends a value of its own: a word, a number, or text with ${value} in it',
    input: true,
    outputs: OUT,
    settings: [{ name: 'value', type: 'value', label: 'Value', required: true }],
  },
  {
    type: 'delay',
    group: 'time',
    label: 'Delay',
    icon: 'hourglass',
    description: 'Sends each value on, later',
    input: true,
    outputs: OUT,
    settings: [{ name: 'for', type: 'duration', label: 'For', required: true }],
  },
  {
    type: 'timer',
    group: 'time',
    label: 'Timer',
    icon: 'alarm',
    description: 'True at once, false a while after the value went false or the last press',
    input: true,
    outputs: BOOL,
    boolean: true,
    settings: [{ name: 'off-after', type: 'duration', label: 'Off after', required: true }, EVERY],
  },
  {
    type: 'held',
    group: 'time',
    label: 'Held',
    icon: 'clock-pause',
    description: 'True once the value has been true a while, false when it is not',
    input: true,
    outputs: BOOL,
    boolean: true,
    settings: [{ name: 'for', type: 'duration', label: 'For', required: true }, EVERY],
  },
  {
    type: 'debounce',
    group: 'time',
    label: 'Debounce',
    icon: 'wave-sine',
    description: 'Sends the last value once none came for a while',
    input: true,
    outputs: OUT,
    settings: [{ name: 'for', type: 'duration', label: 'Quiet for', required: true }],
  },
  {
    type: 'throttle',
    group: 'time',
    label: 'Throttle',
    icon: 'gauge',
    description: 'Sends at most one value in a while, and the newest at its end',
    input: true,
    outputs: OUT,
    settings: [{ name: 'for', type: 'duration', label: 'At most once in', required: true }],
  },
  {
    type: 'between',
    group: 'time',
    label: 'Between',
    icon: 'clock-hour-4',
    description: 'True between two times of day',
    input: false,
    outputs: BOOL,
    boolean: true,
    settings: [
      { name: 'from', type: 'time', label: 'From', required: true },
      { name: 'until', type: 'time', label: 'Until', required: true },
      { name: 'days', type: 'days', label: 'Days' },
      EVERY,
    ],
  },
  {
    type: 'control',
    group: 'action',
    label: 'Control',
    icon: 'toggle-right',
    description: "Writes a device's control, as the automation's owner",
    input: true,
    outputs: OUT,
    settings: [
      { name: 'endpoint', type: 'endpoint', label: 'Control', required: true, help: 'hall-lamp/switch-0' },
      { name: 'value', type: 'value', label: 'Value', help: 'on, off, toggle, 50; the value that came, unless set' },
    ],
  },
  {
    type: 'shell',
    group: 'action',
    label: 'Shell',
    icon: 'terminal-2',
    description: "Runs a command line as the automation's owner; what it prints is sent on",
    input: true,
    outputs: OUT,
    settings: [
      { name: 'run', type: 'line', label: 'Run', required: true, help: 'The value is $VALUE, where it came from $TOPIC' },
      { name: 'timeout', type: 'duration', label: 'Timeout', help: '30s unless set' },
    ],
  },
  {
    type: 'link-out',
    group: 'action',
    label: 'Link out',
    icon: 'link',
    description: "Sends to every link in of the same name, in any of its owner's automations",
    input: true,
    outputs: [],
    settings: [{ name: 'name', type: 'text', label: 'Name', required: true }],
  },
  {
    type: 'debug',
    group: 'action',
    label: 'Debug',
    icon: 'bug',
    description: 'Writes what came to the run log',
    input: true,
    outputs: [],
    settings: [],
  },
];

export const KINDS: Readonly<Record<string, KindSpec>> = Object.fromEntries(kinds.map((kind) => [kind.type, kind]));
