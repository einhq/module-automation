/**
 * Starting points for a new automation (`automation-new --from <name>`, the editor's New), each
 * one a working automation once its devices are changed to the household's own: by hand, or by its
 * slots (`--set lamp=porch-lamp/switch-0`).
 *
 * Import-free, so a page offers them as the command does.
 */

/** A setting of a starting point that `automation-new --set <name>=<value>` fills. */
type Slot = {
  name: string;
  /** What it is, as `automation-new --examples` says it. */
  about: string;
  /** What it takes: a readable endpoint, a writable control, a number, or a word (a time, a duration, a folder). */
  kind: 'reading' | 'control' | 'number' | 'text';
  /** The fields it is written to, as `<node>.<setting>`. */
  sets: string[];
  /** For a `shell` node's `run`: the line, with `{}` where the value goes, quoted for the shell. */
  line?: string;
  /** The nodes taken out, with the wires into them, when it is set to `none`; with none, `none` takes the fields out. */
  drops?: string[];
};

export type Example = { name: string; label: string; description: string; yaml: string; slots?: Slot[] };

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
    to: {out: [dark-and-moving], false: [lamp-off]}
  lux: {type: device, endpoint: hall-sensor/illuminance, pos: [0, 140], to: [dark]}
  dark: {type: compare, below: 30, pos: [240, 140], to: [dark-and-moving]}
  dark-and-moving: {type: and, pos: [480, 60], to: {true: [lamp-on]}}
  lamp-on: {type: control, endpoint: hall-lamp/switch-0, value: on, pos: [720, 0]}
  lamp-off: {type: control, endpoint: hall-lamp/switch-0, value: off, pos: [720, 140]}
`,
    slots: [
      { name: 'motion', about: 'the motion sensor, <device>/<endpoint>', kind: 'reading', sets: ['motion.endpoint'] },
      { name: 'lamp', about: 'the lamp switched, <device>/<endpoint>', kind: 'control', sets: ['lamp-on.endpoint', 'lamp-off.endpoint'] },
      {
        name: 'light-level',
        about: 'the light level that says it is dark, <device>/<endpoint>; none to switch at any light',
        kind: 'reading',
        sets: ['lux.endpoint'],
        drops: ['lux', 'dark'],
      },
      { name: 'dark-below', about: 'how low the light level is when it is dark (30)', kind: 'number', sets: ['dark.below'] },
      { name: 'off-after', about: 'how long after the motion ends the lamp goes off (5m)', kind: 'text', sets: ['linger.off-after'] },
    ],
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
    slots: [
      { name: 'button', about: 'the button, <device>/<endpoint>', kind: 'reading', sets: ['press.endpoint'] },
      { name: 'lamp', about: 'the lamp switched, <device>/<endpoint>', kind: 'control', sets: ['toggle.endpoint'] },
      { name: 'press', about: 'which press: single, double or long; none for every press (single)', kind: 'text', sets: ['press.is'] },
    ],
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
    slots: [
      { name: 'temperature', about: 'the thermometer, <device>/<endpoint>', kind: 'reading', sets: ['temperature.endpoint'] },
      { name: 'heater', about: 'the heater switched, <device>/<endpoint>', kind: 'control', sets: ['heater-on.endpoint', 'heater-off.endpoint'] },
      { name: 'on-below', about: 'the heater on once it has been colder than this a while (19)', kind: 'number', sets: ['cold.below'] },
      { name: 'off-above', about: 'the heater off once it has been warmer than this a while (21)', kind: 'number', sets: ['warm.above'] },
      {
        name: 'away',
        about: 'a switch that is on while no one is home, <device>/<endpoint>; none to heat whoever is home',
        kind: 'reading',
        sets: ['away.endpoint'],
        drops: ['away', 'home'],
      },
    ],
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
    slots: [
      { name: 'lamp', about: 'the lamp switched on, <device>/<endpoint>', kind: 'control', sets: ['lamp-on.endpoint'] },
      { name: 'at', about: 'the time of day, HH:MM (06:30)', kind: 'text', sets: ['morning.at'] },
      { name: 'days', about: 'which days: weekdays, weekends, or some of mon,tue,…; none for every day (weekdays)', kind: 'text', sets: ['morning.days'] },
      { name: 'value', about: 'what is written to it: on, off, toggle or a number (on)', kind: 'text', sets: ['lamp-on.value'] },
    ],
  },
  {
    name: 'inbox',
    label: 'A file in a folder',
    description: 'Each PDF that comes into a folder is moved on to another',
    yaml: `description: Each PDF scanned into the inbox is moved to the documents folder
nodes:
  scan: {type: file, folder: /home/anna/inbox, match: '*.pdf', pos: [0, 0], to: [file-it]}
  file-it: {type: shell, run: 'mv "$VALUE" /home/anna/documents/ && echo "filed $VALUE"', pos: [260, 0], to: [shown]}
  shown: {type: debug, pos: [520, 0]}
`,
    slots: [
      { name: 'folder', about: 'the folder watched', kind: 'text', sets: ['scan.folder'] },
      { name: 'match', about: 'which files, as a pattern; none for every file (*.pdf)', kind: 'text', sets: ['scan.match'] },
      { name: 'to', about: 'the folder each is moved to', kind: 'text', sets: ['file-it.run'], line: 'mv "$VALUE" {}/ && echo "filed $VALUE"' },
    ],
  },
  {
    name: 'dusk-to-dawn',
    label: 'From sunset to sunrise',
    description: 'A lamp on at sunset and off at sunrise, which move with the year',
    yaml: `description: The porch lamp on from sunset until sunrise
nodes:
  dark: {type: between, from: sunset, until: sunrise, location: '59.33, 18.07', pos: [0, 60], to: {true: [lamp-on], false: [lamp-off]}}
  lamp-on: {type: control, endpoint: porch-lamp/switch-0, value: on, pos: [260, 0]}
  lamp-off: {type: control, endpoint: porch-lamp/switch-0, value: off, pos: [260, 120]}
`,
    slots: [
      { name: 'lamp', about: 'the lamp switched, <device>/<endpoint>', kind: 'control', sets: ['lamp-on.endpoint', 'lamp-off.endpoint'] },
      { name: 'location', about: 'where the sun is reckoned, <latitude>, <longitude>', kind: 'text', sets: ['dark.location'] },
      { name: 'from', about: 'on from: sunset, dusk, a time, or one with an offset such as sunset-30m (sunset)', kind: 'text', sets: ['dark.from'] },
      { name: 'until', about: 'off at: sunrise, dawn, a time, or one with an offset (sunrise)', kind: 'text', sets: ['dark.until'] },
    ],
  },
  {
    name: 'tour',
    label: 'Tour of every node',
    description: 'Eight small flows, every kind of node among them, with invented devices: to simulate, read and copy from',
    // The same text as etc/automations.d/tour.yaml, the module's own automation/tour: a test keeps them one.
    yaml: `# A tour of automations: eight small flows, every kind of node among them. Its devices are invented
# (example-…), so it switches nothing real. Open it under System → Automations and simulate it with
# the flask, feeding it readings and presses by hand; or make one of your own from it (New, starting
# point Tour; or automation-new <name> --from tour) and set your own devices. It comes off, and is
# best left so.
description: A tour of every kind of node in eight small flows; its devices are invented, so simulate it or copy it
enabled: false
nodes:
  # 1. Motion light. The hall lamp on at motion while it is dark and someone is home, off five
  #    minutes after the motion ends. The timer's out (true, then false) goes to the and, so the and
  #    knows when the motion is over; its false goes on to switch the lamp off.
  #    device, compare, not, and, timer, control.
  motion: { type: device, label: Hall motion, endpoint: example-hall/motion, pos: [0, 0], to: [linger] }
  linger: { type: timer, off-after: 5m, pos: [300, 0], to: { out: [lamp-wanted], false: [lamp-off] } }
  lux: { type: device, label: Hall light level, endpoint: example-hall/illuminance, pos: [0, 120], to: [dark] }
  dark: { type: compare, below: 30, pos: [300, 120], to: [lamp-wanted] }
  away: { type: device, label: Away mode, endpoint: example-house/away, pos: [0, 240], to: [home] }
  home: { type: not, label: Someone home, pos: [300, 240], to: [lamp-wanted] }
  lamp-wanted: { type: and, pos: [600, 120], to: { true: [lamp-on] } }
  lamp-on: { type: control, endpoint: example-hall-lamp/switch-0, value: 'on', pos: [900, 60] }
  lamp-off: { type: control, endpoint: example-hall-lamp/switch-0, value: 'off', pos: [900, 180] }

  # 2. A button. A single press toggles the lamp, a long press switches it off. A device node's
  #    "is" passes on one kind of press; set sends a value of its own, and a control with no value
  #    writes the one that came. The button node is pressed by hand: Press in its panel, or
  #    automation-trigger automation/tour try-it. device (is), button, set, control (toggle).
  single: { type: device, label: Single press, endpoint: example-button/input-0, is: single, pos: [0, 400], to: [toggle] }
  try-it: { type: button, label: Try it, pos: [0, 520], to: [toggle] }
  toggle: { type: control, endpoint: example-hall-lamp/switch-0, value: toggle, pos: [300, 460] }
  long: { type: device, label: Long press, endpoint: example-button/input-0, is: long, pos: [0, 640], to: [all-off] }
  all-off: { type: set, value: 'off', pos: [300, 640], to: [lamp-off-too] }
  lamp-off-too: { type: control, label: Lamp as told, endpoint: example-hall-lamp/switch-0, pos: [600, 640] }

  # 3. Temperature. Readings steadied, written to the run log in Fahrenheit, and sorted into
  #    bands that switch a heater. debounce, math, debug, switch.
  temperature: { type: device, label: Hall temperature, endpoint: example-hall/temperature, pos: [0, 800], to: [steady] }
  steady: { type: debounce, for: 30s, pos: [300, 800], to: [fahrenheit, band] }
  fahrenheit: { type: math, expression: 'round(value * 1.8 + 32, 1)', pos: [600, 740], to: [in-fahrenheit] }
  in-fahrenheit: { type: debug, pos: [900, 740] }
  band: { type: switch, cases: { cold: { below: 19 }, warm: { above: 23 } }, pos: [600, 880], to: { cold: [heater-on], warm: [heater-off], else: [comfortable] } }
  heater-on: { type: control, endpoint: example-heater/switch-0, value: 'on', pos: [900, 860] }
  heater-off: { type: control, endpoint: example-heater/switch-0, value: 'off', pos: [900, 980] }
  comfortable: { type: debug, pos: [900, 1100] }

  # 4. The average indoors, from two rooms, sent on at most every five minutes to any automation
  #    of the same owner that listens for it: flow 5 here. aggregate, throttle, link out.
  bedroom: { type: device, label: Bedroom temperature, endpoint: example-bedroom/temperature, pos: [0, 1280], to: [indoors] }
  kitchen: { type: device, label: Kitchen temperature, endpoint: example-kitchen/temperature, pos: [0, 1400], to: [indoors] }
  indoors: { type: aggregate, fn: avg, pos: [300, 1340], to: [now-and-then] }
  now-and-then: { type: throttle, for: 5m, pos: [600, 1340], to: [share] }
  share: { type: link-out, name: indoor-average, pos: [900, 1340] }

  # 5. What the link brings: too warm for ten minutes, or a window open, is said with a command
  #    line, whose output goes to the run log. link in, compare, held, or, shell.
  indoor-average: { type: link-in, name: indoor-average, pos: [0, 1560], to: [too-warm] }
  too-warm: { type: compare, above: 25, pos: [300, 1560], to: [warm-a-while] }
  warm-a-while: { type: held, for: 10m, pos: [600, 1560], to: [say-so] }
  window: { type: device, label: Window open, endpoint: example-window/contact, pos: [300, 1680], to: [say-so] }
  say-so: { type: or, pos: [900, 1620], to: { true: [note] } }
  note: { type: shell, run: 'echo "too warm, or a window open: $TOPIC said $VALUE"', pos: [1200, 1620], to: [noted] }
  noted: { type: debug, pos: [1500, 1620] }

  # 6. The clock. The blinds up at half past six on weekdays and the lamp off a quarter of an hour
  #    later; night from dusk until dawn where the house is; the date every hour; and the router
  #    coming and going. clock, delay, between, online.
  morning: { type: clock, at: '06:30', days: weekdays, pos: [0, 1840], to: [blinds-up, quarter-later] }
  blinds-up: { type: control, endpoint: example-blinds/position, value: 100, pos: [300, 1780] }
  quarter-later: { type: delay, for: 15m, pos: [300, 1900], to: [lamp-off-morning] }
  lamp-off-morning: { type: control, endpoint: example-hall-lamp/switch-0, value: 'off', pos: [600, 1900] }
  night: { type: between, from: dusk, until: dawn, location: '59.33, 18.07', pos: [0, 2040], to: [is-night] }
  is-night: { type: debug, pos: [300, 2040] }
  hourly: { type: clock, every: 1h, pos: [0, 2160], to: [the-date] }
  the-date: { type: shell, run: date, timeout: 10s, pos: [300, 2160], to: [dated] }
  dated: { type: debug, pos: [600, 2160] }
  router: { type: online, device: example-router, pos: [0, 2280], to: [router-there] }
  router-there: { type: debug, pos: [300, 2280] }

  # 7. A file. The path of each PDF that comes into a folder, made there or moved in, once it is
  #    written in full; another kind of file is held back. file.
  scans: { type: file, label: Scans, folder: /home/example/inbox, match: '*.pdf', pos: [0, 2440], to: [scanned] }
  scanned: { type: debug, pos: [300, 2440] }

  # 8. EiN's events. A failed run of the example-upkeep pipeline is written to the run log, and
  #    raises an event of its own about the same node, for a pipeline that waits for it. Only the
  #    administrator raises events: take raise-it out of a copy of your own. event in, event out.
  upkeep-failed: { type: event-in, event: pipeline.instance.failed, with: pipeline=example-upkeep, pos: [0, 2600], to: [failed-run, raise-it] }
  failed-run: { type: debug, pos: [300, 2540] }
  raise-it: { type: event-out, event: example.upkeep.failed, pos: [300, 2660] }
`,
  },
];
