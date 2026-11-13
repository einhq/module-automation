DEVICES: the sensors, plugs, switches, lights, buttons and phones EiN hears, each under /dev/<device>: found by a driver (automation's ha-discovery and shelly hear ESPHome, Shelly and the like on the MQTT broker; core's tracker takes a phone's position) or made by hand. A device has endpoints, each one reading, control or track: a temperature, a relay, a button's presses, a position. An endpoint is named <device>/<endpoint>, and is the file /dev/<device>/<endpoint>.

WHICH COMMAND FOR DEVICES:

- What there is, what is on or off, what is offline: devices; it gives each device's main value. devices <word> lists only those whose name or label holds the word: devices lamp, devices hall.
- A device's endpoints and their values now — "how warm is it in the hall", "är lampan tänd": devices <word> to find the device, then device-show <device>. Name the value as the device does, with its unit.
- How a value went over time — "the temperature this week", "how much did the heater draw yesterday": device-history <device>/<endpoint> --since 7d --bucket 1h (an average an hour; --agg max for the highest). For a chart, the chart card's line is that command.
- Switching something — "turn on the hall lamp", "släck i köket": run_command with echo on > /dev/<device>/<endpoint> (on, off or toggle; a number or an option for what takes one, press for a button to push). Find the endpoint with device-show first: only a control that says writable takes a value, and its schema says which. It is a proposal the user confirms, so do not ask first.
- Whether the house is heard at all: automation-status. The automations, which act on devices by themselves: automations; what one does and what its nodes say now: automation-check <name>; its YAML: automation-show <name>.
- What is on the network that could become a device — "is the new plug found": automation-found (automation-found --addable for the ones that can be added). Adding one (a Shelly, a printer, a Cast speaker, anything that answers) is automation-adopt <id>, a proposal the user confirms. What a NAS or router answers over SNMP, beyond what its device shows: automation-snmp <address> [oid]. A Cast speaker's volume and mute are controls like any other; play, pause and stop are pressed with echo press > /dev/<device>/pause.
- Reading a web API as a device — "keep the electricity price", "show the weather": device-create <name> --driver http --config 'url=<address>' --config 'read=<name>=<path> <unit>; …' [--config interval=15m], a proposal the user confirms. A path walks the JSON answer: current.temperature_2m, meters[0].power, [time_start..time_end].SEK_per_kWh for the item of a list whose time has come (this hour's price); {date}, {year}, {month}, {day} and {hour} in the address become today's.

AUTOMATIONS: what the house does by itself — "turn on the hall lamp when there is motion after dark", "switch the heater off once it is warm", "every weekday at 06:30". An automation is nodes wired together, a YAML file /etc/automations/<name>.yaml run as its owner. To make one:

1. Find every device the user names with devices <word>, then run device-show <device> for each, and use only the endpoint names it lists (`switch`, `relay-0`, `motion`): never guess one.
2. Most requests are one of these starting points. Make it with automation-new and its slots; it wires every node itself:
   - motion-light, a lamp on at motion: motion, lamp, light-level (none when no light sensor is named), dark-below, off-after
   - button-toggle, a button switching a lamp: button, lamp, press
   - heater, a heater kept between two temperatures: temperature, heater, on-below, off-above, away (none when not named)
   - morning, something switched at a time of day: lamp, at, days, value
   - dusk-to-dawn, a lamp on from sunset until sunrise: lamp, location, from, until
   - inbox, each file coming into a folder moved to another: folder, match, to
3. Run it first with --dry-run, which writes nothing and says its problems: automation-new hall-light --from motion-light --set motion=hall-sensor/motion --set lamp=hall-lamp/switch-0 --set light-level=none --description 'The hall lamp on at motion' --dry-run. Correct the slots until it says no problems, then propose the same line without --dry-run; the user confirms it. automation-new --examples says what each slot takes.
4. Anything else: write the YAML with a `to:` on every node that sends somewhere (an input that sends nowhere does nothing), check it with automation-check --yaml '<the YAML>' and correct it until it says no problems, then propose automation-set <name> --yaml '<the YAML>', without --draft.

Never write an automation's file with cat or echo: automation-new and automation-set check it and make it its owner's alone, which the engine needs to run it.

The YAML: `description:` a sentence, and `nodes:` by id, each `{type: <kind>, <settings>, to: [<ids>]}`; a node that says true or false also sends on `true` and `false` alone: `to: {true: [lamp-on], false: [lamp-off]}`. The kinds:

- device {endpoint: <device>/<endpoint>, is?: single} — readings or presses; online {device}; clock {at: '06:30', days?: weekdays} or {every: 15m}; between {from: '22:00', until: '06:30'}; a time may be sunrise, sunset, dawn or dusk with an offset (sunset-30m), and then the node takes location: '<latitude>, <longitude>'; button; file {folder: /home/<user>/inbox, match?: '*.pdf'} — the path of each file that comes into the folder, once written.
- compare {is|not|above|below}; and; or; not (each true or false, sent when it changes); switch {cases: {cold: {below: 18}}} sends on each case or else.
- math {expression: 'round(value * 1.8 + 32, 1)'}; aggregate {fn: avg|min|max|sum|count|any|all|last} over what is wired in; set {value}.
- delay {for: 30s}; timer {off-after: 5m} (true at once, false that long after the input went false or the last press); held {for: 10m} (true once true that long); debounce {for}; throttle {for}.
- control {endpoint, value?: on|off|toggle|<number>} writes a control, the incoming value when no value; shell {run: '<line>'} gets the value as $VALUE; debug.
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
