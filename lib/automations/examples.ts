/**
 * Starting points for a new automation (`automation-new --from <name>`, the editor's New), each
 * one a working automation once its devices are changed to the household's own.
 *
 * Import-free, so a page offers them as the command does.
 */

type Example = { name: string; label: string; description: string; yaml: string };

export const EXAMPLES: readonly Example[] = [
  {
    name: 'empty',
    label: 'Empty',
    description: 'Nothing yet: add nodes and wire them',
    yaml: 'description: \nnodes: {}\n',
  },
  {
    name: 'motion-light',
    label: 'Motion light',
    description: 'A lamp on at motion when it is dark, off a while after the motion ends',
    yaml: `description: The hall lamp on at motion when it is dark, off five minutes after the motion ends
nodes:
  motion: {type: device, endpoint: hall-sensor/motion, pos: [0, 0], to: [linger]}
  linger:
    type: timer
    off-after: 5m
    pos: [240, 0]
    to: {true: [dark-and-moving], false: [lamp-off]}
  lux: {type: device, endpoint: hall-sensor/illuminance, pos: [0, 140], to: [dark]}
  dark: {type: compare, below: 30, pos: [240, 140], to: [dark-and-moving]}
  dark-and-moving: {type: and, pos: [480, 60], to: {true: [lamp-on]}}
  lamp-on: {type: control, endpoint: hall-lamp/switch-0, value: on, pos: [720, 0]}
  lamp-off: {type: control, endpoint: hall-lamp/switch-0, value: off, pos: [720, 140]}
`,
  },
  {
    name: 'button-toggle',
    label: 'Button toggles a lamp',
    description: 'One press of a button switches a lamp on or off',
    yaml: `description: A press of the porch button switches the hall lamp on or off
nodes:
  press: {type: device, endpoint: porch-button/input-0, is: single, pos: [0, 0], to: [toggle]}
  try-it: {type: button, label: Try it, pos: [0, 120], to: [toggle]}
  toggle: {type: control, endpoint: hall-lamp/switch-0, value: toggle, pos: [260, 60]}
`,
  },
  {
    name: 'heater',
    label: 'Heater between two temperatures',
    description: 'A heater on once it has been cold a while, off once it has been warm, while someone is home',
    yaml: `description: The heater keeps the hall between 19 and 21 °C while someone is home
nodes:
  temperature: {type: device, endpoint: hall-sensor/temperature, pos: [0, 60], to: [cold, warm]}
  cold: {type: compare, below: 19, pos: [240, 0], to: [cold-a-while]}
  cold-a-while: {type: held, for: 10m, pos: [480, 0], to: [heat]}
  away: {type: device, endpoint: indoors/away, pos: [240, 120], to: [home]}
  home: {type: not, pos: [480, 120], to: [heat]}
  heat: {type: and, pos: [720, 40], to: {true: [heater-on]}}
  warm: {type: compare, above: 21, pos: [240, 240], to: [warm-a-while]}
  warm-a-while: {type: held, for: 5m, pos: [480, 240], to: {true: [heater-off]}}
  heater-on: {type: control, endpoint: heater-plug/switch-0, value: on, pos: [960, 40]}
  heater-off: {type: control, endpoint: heater-plug/switch-0, value: off, pos: [960, 240]}
`,
  },
  {
    name: 'morning',
    label: 'At a time of day',
    description: 'A lamp on at half past six on weekdays, and a note of it',
    yaml: `description: The hall lamp on at half past six on weekdays
nodes:
  morning: {type: clock, at: '06:30', days: weekdays, pos: [0, 0], to: [lamp-on, note]}
  lamp-on: {type: control, endpoint: hall-lamp/switch-0, value: on, pos: [260, 0]}
  note: {type: shell, run: 'echo "morning at $VALUE"', pos: [260, 120], to: [shown]}
  shown: {type: debug, pos: [520, 120]}
`,
  },
];
