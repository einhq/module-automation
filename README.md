# module-automation

MQTT drivers and rules for EiN's devices. The `automation-bridge` service listens on an MQTT broker
and drives what it hears as devices under `/dev`: `ha-discovery` for anything that announces itself
the way Home Assistant reads (ESPHome, Zigbee2MQTT), `shelly` for Shelly's second generation and
later, `shelly-gen1` for the first (Plug S, 1, 1PM, 2.5, i3). Their readings and presses become the devices' endpoints, published on `dev.<device>.<endpoint>`
for queues and logs to take, and a value written to a control (`echo on > /dev/hall-plug/switch-0`)
is sent to the device. The `automation-rules` service runs the rules under `/etc/automation/rules`
when a reading, a press, a device coming or going or the clock says so.

Devices that are on the network but not yet on the broker are found too. A listener beside the
broker on the host's own network (EiN's deployment runs it with the broker) asks mDNS and SSDP
what is there and publishes each address it heard as a retained message under
`ein/discovery/host/<id>`, with its own `ein/discovery/status`. The bridge keeps those:
`automation-found` names each one (a Shelly, ESPHome, a HomeKit or Matter accessory, a Hue bridge,
a speaker, a printer, …), says whether it is a device already and, given one, shows all the
listener heard of it. `automation-adopt` adds one: a Shelly's MQTT is pointed at the broker and it
is restarted, so its driver takes it; anything else becomes a device of a driver that asks it
itself, over the network: `ipp` for a printer (state, warnings, ink and toner), `cast` for a Google
Cast speaker (what it plays; volume, mute, play, pause and stop), and `network` for the rest
(whether it answers, and how fast). `automation-ignore` leaves one out. The Devices page shows how
many can be added, and opens them as a page of their own.

The devices, their pages and the device commands are EiN core's; this module brings the drivers and
the rules.

An [EiN](https://github.com/einhq) module. It is developed and tested inside a checkout of EiN core,
as `modules/automation`, and a deployment chooses whether to run it.
