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
  /** The kind's colour, a Mantine colour's name: its card's band and icon, its line in the menu. */
  color: string;
  /** What it does with what comes in, and what it sends: the docs at the foot of its panel. */
  about: string;
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
  { name: 'is', type: 'value', label: 'Is', help: 'The same value: on, 21, open' },
  { name: 'not', type: 'value', label: 'Is not', help: 'Anything but this value' },
  { name: 'above', type: 'number', label: 'Above', help: 'A number it must be over' },
  { name: 'below', type: 'number', label: 'Below', help: 'A number it must be under' },
];

const kinds: KindSpec[] = [
  {
    type: 'device',
    group: 'input',
    label: 'Device',
    color: 'blue',
    about:
      "Sends each reading of the endpoint as it arrives, and each press of a button: a number, a word such as on or single, or text, as the device gives it. With **Only when it is** set, it sends only those that are that value, so a button's `single` and `long` presses can go different ways.",
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
    color: 'cyan',
    about: 'Says whether the device answers: true when it comes online, false when it goes away, each once, when it changes.',
    icon: 'wifi',
    description: 'Whether a device is online',
    input: false,
    outputs: BOOL,
    boolean: true,
    settings: [{ name: 'device', type: 'device', label: 'Device', required: true, help: 'The device to follow' }, EVERY],
  },
  {
    type: 'clock',
    group: 'input',
    label: 'Clock',
    color: 'indigo',
    about:
      "Sends the time, as text such as `07:30`, at **At** on the **Days** given, or every **Every** (a minute or more) on the minute. Give At or Every. The time zone is the system's.",
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
    color: 'violet',
    about:
      'Sends **Sends** (true unless set) when it is pressed: with **Press** in its panel, or with `automation-trigger <automation> <node>` in the terminal, while the automation runs. For trying an automation out, or starting one by hand.',
    icon: 'hand-finger',
    description: 'Pressed in its panel, or with automation-trigger',
    input: false,
    outputs: OUT,
    settings: [{ name: 'value', type: 'value', label: 'Sends', help: 'true unless set' }],
  },
  {
    type: 'link-in',
    group: 'input',
    label: 'Link in',
    color: 'grape',
    about: "Sends on whatever a **Link out** of the same **Link name** sends, from any automation of the same owner: one automation's result becomes another's input.",
    icon: 'link',
    description: "What a link out of the same name sends, from any of its owner's automations",
    input: false,
    outputs: OUT,
    settings: [{ name: 'name', type: 'text', label: 'Link name', required: true, help: "The same as a link out's, in any of its owner's automations" }],
  },
  {
    type: 'compare',
    group: 'logic',
    label: 'Compare',
    color: 'yellow',
    about:
      'Tests each value that comes: **Is** and **Is not** match it as the same value, where on, true and yes are one, as are off, false and no, and a number matches its text (21 is "21"); other text must match exactly, case and all. **Above** and **Below** take numbers: text that is no number fails them. Every test given must hold. It sends true or false, on out and on the output of that name.',
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
    color: 'orange',
    about: 'True while every node wired into it last sent something true, false as soon as one did not. A value is true unless it is false, 0, off, no, closed or empty.',
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
    color: 'lime',
    about: 'True while any node wired into it last sent something true, false when none did. A value is true unless it is false, 0, off, no, closed or empty.',
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
    color: 'pink',
    about: 'Sends the opposite of each value: true for false, 0, off, no, closed or empty, false for anything else.',
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
    color: 'teal',
    about:
      "Sends the value on to the output of the first case whose tests it passes, and on else when none does. A case's tests are a compare's (is, not, above, below), with the same rules for text and numbers. Each case is an output of its own to wire.",
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
    color: 'green',
    about:
      'Works out a value from **Expression**: `value` is what came, `topic` where it came from, and each node wired in is there by its name, with - as _ (`outdoor_sensor`). It has + - * / %, comparisons, && || ! and ? :, and round, floor, ceil, abs, min, max, avg, sum and clamp. A value that is no number where a number is needed stops it with a problem on the card and in the run log, and nothing is sent; until every node it names has sent something, it waits.',
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
    color: 'cyan',
    about:
      'Combines what the nodes wired into it last sent: avg, min, max and sum over those that are numbers (text that is a number counts), count of those that are true, any and all of them true, or last, the newest. It sends when the result changes.',
    icon: 'math-avg',
    description: 'The average, least, most, sum or count of what is wired in',
    input: true,
    outputs: OUT,
    settings: [{ name: 'fn', type: 'choice', label: 'Of', required: true, choices: AGGREGATES, help: 'avg, min, max, sum, count, any, all or last' }, EVERY],
  },
  {
    type: 'set',
    group: 'value',
    label: 'Set',
    color: 'violet',
    about:
      'Sends **Value** in place of what came, at the moment it came: a word, a number, or text with `${value}` and `${topic}` in it, filled in with what came and where from.',
    icon: 'pencil',
    description: 'Sends a value of its own: a word, a number, or text with ${value} in it',
    input: true,
    outputs: OUT,
    settings: [{ name: 'value', type: 'value', label: 'Value', required: true, help: 'on, 21, or text with ${value} and ${topic}' }],
  },
  {
    type: 'delay',
    group: 'time',
    label: 'Delay',
    color: 'indigo',
    about: 'Sends each value on unchanged, **For** later. Every value gets its own wait, and a restart of the service keeps them.',
    icon: 'hourglass',
    description: 'Sends each value on, later',
    input: true,
    outputs: OUT,
    settings: [{ name: 'for', type: 'duration', label: 'For', required: true, help: '30s, 5m, 1h' }],
  },
  {
    type: 'timer',
    group: 'time',
    label: 'Timer',
    color: 'orange',
    about:
      'True at once when a true value comes; false **Off after** later, counted from the value that went false, or from the last press of a button. A true value meanwhile stops the count, and another press starts it again. The lamp that stays on a while after the motion ends.',
    icon: 'alarm',
    description: 'True at once, false a while after the value went false or the last press',
    input: true,
    outputs: BOOL,
    boolean: true,
    settings: [{ name: 'off-after', type: 'duration', label: 'Off after', required: true, help: '5m after the value went false' }, EVERY],
  },
  {
    type: 'held',
    group: 'time',
    label: 'Held',
    color: 'yellow',
    about: 'True once the value has stayed true for **For**; false as soon as it is not. A door left open, a leak that goes on.',
    icon: 'clock-pause',
    description: 'True once the value has been true a while, false when it is not',
    input: true,
    outputs: BOOL,
    boolean: true,
    settings: [{ name: 'for', type: 'duration', label: 'For', required: true, help: '10m: how long it must stay true' }, EVERY],
  },
  {
    type: 'debounce',
    group: 'time',
    label: 'Debounce',
    color: 'teal',
    about: 'Sends the last value once none has come for **Quiet for**: a burst of readings becomes one.',
    icon: 'wave-sine',
    description: 'Sends the last value once none came for a while',
    input: true,
    outputs: OUT,
    settings: [{ name: 'for', type: 'duration', label: 'Quiet for', required: true, help: '2s with nothing coming' }],
  },
  {
    type: 'throttle',
    group: 'time',
    label: 'Throttle',
    color: 'pink',
    about: 'Sends a value at once, then at most one in each **At most once in**: those that come meanwhile are dropped, but for the newest, sent when the time is up.',
    icon: 'gauge',
    description: 'Sends at most one value in a while, and the newest at its end',
    input: true,
    outputs: OUT,
    settings: [{ name: 'for', type: 'duration', label: 'At most once in', required: true, help: '1m' }],
  },
  {
    type: 'between',
    group: 'time',
    label: 'Between',
    color: 'blue',
    about:
      'True between **From** and **Until** on the **Days** given (every day unless set), false outside them. It needs nothing wired in, and Until before From runs over midnight.',
    icon: 'clock-hour-4',
    description: 'True between two times of day',
    input: false,
    outputs: BOOL,
    boolean: true,
    settings: [
      { name: 'from', type: 'time', label: 'From', required: true, help: '22:00, in the system time zone' },
      { name: 'until', type: 'time', label: 'Until', required: true, help: '06:30; before From, it runs over midnight' },
      { name: 'days', type: 'days', label: 'Days', help: 'weekdays, weekends, or [mon, wed, fri]; every day unless set' },
      EVERY,
    ],
  },
  {
    type: 'control',
    group: 'action',
    label: 'Control',
    color: 'green',
    about:
      "Writes **Value** to the control, or the value that came when Value is not set: on and off for true and false, toggle, or a number. A value the control has already is not written again, but for toggle. It writes as the automation's owner, who must be allowed to, and sends the value on once written.",
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
    color: 'lime',
    about:
      "Runs **Run** as the automation's owner, with the value in `$VALUE` and where it came from in `$TOPIC`, one at a time in order. What it prints is sent on: a number as a number, nothing as null. A line that fails or runs past **Timeout** is a problem on the card and in the run log.",
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
    color: 'grape',
    about: 'Sends what comes to every **Link in** of the same **Link name**, in any automation of the same owner.',
    icon: 'link',
    description: "Sends to every link in of the same name, in any of its owner's automations",
    input: true,
    outputs: [],
    settings: [{ name: 'name', type: 'text', label: 'Link name', required: true, help: "The same as a link in's, in any of its owner's automations" }],
  },
  {
    type: 'debug',
    group: 'action',
    label: 'Debug',
    color: 'gray',
    about: "Writes each value that comes, and where it came from, to the automation's run log (the Runs tab), and shows the last on its card.",
    icon: 'bug',
    description: 'Writes what came to the run log',
    input: true,
    outputs: [],
    settings: [],
  },
];

export const KINDS: Readonly<Record<string, KindSpec>> = Object.fromEntries(kinds.map((kind) => [kind.type, kind]));
