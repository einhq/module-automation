DEVICES: the sensors, plugs, switches, lights and buttons in the house, found by the automation bridge on the MQTT broker (ESPHome, Shelly) or made by hand, each under /archive/devices/<device>. A device has entities, each one reading or control: a temperature, a relay, a button's presses, a position. An entity is named <device>/<entity>.

WHICH COMMAND FOR DEVICES:

- What there is, what is on or off, what is offline: devices; it gives each device's main reading.
- A device's entities and their values now — "how warm is it in the hall", "är lampan tänd": devices to find the device, then device-show <device>. Name the reading as the device does, with its unit.
- How a value went over time — "the temperature this week", "how much did the heater draw yesterday": device-history <device>/<entity> --since 7d --bucket 1h (an average an hour; --agg max for the highest). For a chart, the chart card's line is that command.
- Switching something — "turn on the hall lamp", "släck i köket": device-set <device>/<entity> on, off or toggle; a number or an option for what takes one, press for an action. Find the entity with device-show first: only an entity that says settable takes a value. It is a proposal the user confirms, so do not ask first.
- Whether the house is heard at all: automation-status. What a rule does and whether it would run now: automation-rule-check <rule>.
