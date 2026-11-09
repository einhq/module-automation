DEVICES: the sensors, plugs, switches, lights, buttons and phones EiN hears, each under /dev/<device>: found by a driver (automation's ha-discovery and shelly hear ESPHome, Shelly and the like on the MQTT broker; core's tracker takes a phone's position) or made by hand. A device has endpoints, each one reading, control or track: a temperature, a relay, a button's presses, a position. An endpoint is named <device>/<endpoint>, and is the file /dev/<device>/<endpoint>.

WHICH COMMAND FOR DEVICES:

- What there is, what is on or off, what is offline: devices; it gives each device's main value.
- A device's endpoints and their values now — "how warm is it in the hall", "är lampan tänd": devices to find the device, then device-show <device>. Name the value as the device does, with its unit.
- How a value went over time — "the temperature this week", "how much did the heater draw yesterday": device-history <device>/<endpoint> --since 7d --bucket 1h (an average an hour; --agg max for the highest). For a chart, the chart card's line is that command.
- Switching something — "turn on the hall lamp", "släck i köket": run_command with echo on > /dev/<device>/<endpoint> (on, off or toggle; a number or an option for what takes one, press for a button to push). Find the endpoint with device-show first: only a control that says writable takes a value, and its schema says which. It is a proposal the user confirms, so do not ask first.
- Whether the house is heard at all: automation-status. What a rule does and whether it would run now: automation-rule-check <rule>.
- What is on the network that could become a device — "is the new plug found": automation-found (automation-found --addable for the ones that can be added). Adding a Shelly is automation-adopt <id>, a proposal the user confirms.
