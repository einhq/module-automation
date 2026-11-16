AUTOMATIONS: what the house does by itself — "turn on the hall lamp when there is motion after dark", "switch the heater off once it is warm", "every weekday at 06:30". An automation is nodes wired together, a YAML file /etc/automations/<name>.yaml run as its owner, acting on the devices under /dev/<device>, each endpoint named <device>/<endpoint>. The automations: automations; what one does and what its nodes say now: automation-check <name>; its YAML: automation-show <name>; whether the engine runs them: automation-status. To make one:

1. Find every device the user names with devices <word>, then run device-show <device> for each, and use only the endpoint names it lists (`switch`, `relay-0`, `motion`): never guess one.
2. When one of these starting points does what was asked, all of it and no more, make it with automation-new and its slots; it wires every node itself:
   - motion-light, a lamp on at motion: motion, lamp, light-level, dark-below, off-after. When the user says dark, light-level is the endpoint that reads the light (illuminance, lux) and the lamp goes on only in the dark; light-level=none is for a lamp on at motion at any light
   - button-toggle, a button switching a lamp: button, lamp, press
   - heater, a heater switched on below one temperature and off above another: temperature, heater, on-below, off-above, away (none when not named). Only one of the two asked for: the other is none
   - morning, something switched at a time of day: lamp, at, days, value
   - dusk-to-dawn, a lamp on from sunset until sunrise: lamp, location, from, until
   - inbox, each file coming into a folder moved to another: folder, match, to
3. Propose it: automation-new hall-light --from motion-light --set motion=hall-sensor/motion --set lamp=hall-lamp/switch-0 --set light-level=hall-sensor/illuminance --description 'The hall lamp on at motion when it is dark'. It is tried with --dry-run before the user sees it; if that finds problems you are told them instead, so correct the slots and propose it again. Propose the automation-new line itself, never the YAML it makes. automation-new --examples says what each slot takes.
4. Anything else: write the YAML with a `to:` on every node that sends somewhere (an input that sends nowhere does nothing), and propose automation-set <name> --yaml '<the YAML>', without --draft. It is checked the same way first.

Never write an automation's file with cat or echo: automation-new and automation-set check it and make it its owner's alone, which the engine needs to run it.

The YAML: `description:` a sentence, and `nodes:` by id, each `{type: <kind>, <settings>, to: [<ids>]}`; a node that says true or false also sends on `true` and `false` alone: `to: {true: [lamp-on], false: [lamp-off]}`. The kinds:

- device {endpoint: <device>/<endpoint>, is?: single} — readings or presses; online {device}; clock {at: '06:30', days?: weekdays} or {every: 15m}; between {from: '22:00', until: '06:30'}; a time may be sunrise, sunset, dawn or dusk with an offset (sunset-30m), and then the node takes location: '<latitude>, <longitude>'; button; file {folder: /home/<user>/inbox, match?: '*.pdf'} — the path of each file that comes into the folder, once written.
- compare {is|not|above|below}; and; or; not (each true or false, sent when it changes); switch {cases: {cold: {below: 18}}} sends on each case or else.
- math {expression: 'round(value * 1.8 + 32, 1)'}; aggregate {fn: avg|min|max|sum|count|any|all|last} over what is wired in; set {value}.
- delay {for: 30s}; timer {off-after: 5m} (true at once, false that long after the input went false or the last press); held {for: 10m} (true once true that long); debounce {for}; throttle {for}.
- control {endpoint, value?: on|off|toggle|<number>} writes a control, the incoming value when no value; shell {run: '<line>', outputs?: [heat, note]} gets the value as $VALUE and each node wired in as $<its id, - as _>, and a printed line heat=on sends on on its output heat; script {script: check.sh, outputs?} runs the automation's own script, a file under its YAML file's scripts/ that the user makes on the Scripts tab, the same way; debug.
- event-in {event: pipeline.instance.completed, under?: /home/anna/Photos, with?: pipeline=<name>} sends the path an event of EiN is about (`*` one word, `#` any); event-out {event: automation.<words>, subject?: <path>} raises one for pipelines, the administrator's automations only.

A motion light:

```yaml
description: The hall lamp on at motion when it is dark, off five minutes after the motion ends
nodes:
  motion: { type: device, endpoint: hall-sensor/motion, to: [linger] }
  linger: { type: timer, off-after: 5m, to: { out: [dark-and-moving], false: [lamp-off] } }
  lux: { type: device, endpoint: hall-sensor/illuminance, to: [dark] }
  dark: { type: compare, below: 30, to: [dark-and-moving] }
  dark-and-moving: { type: and, to: { true: [lamp-on] } }
  lamp-on: { type: control, endpoint: hall-lamp/switch-0, value: on }
  lamp-off: { type: control, endpoint: hall-lamp/switch-0, value: off }
```

An and, or, math or aggregate keeps the latest value of each node wired into it: wire a true-or-false node's out into it (true and false both), not its true alone, or it holds true for ever once true came.

`automation-show automation/tour` is a tour of every kind of node, its YAML commented flow by flow.

A reading worked out from several devices' (an average indoors, whether any window is open) is a virtual device rather than an automation: device-create <name> --driver virtual --config 'read=<reading>=avg <device>/<endpoint> <device>/<endpoint>', and --config 'set=away=bool' for a switch with no hardware behind it, a proposal the user confirms.
