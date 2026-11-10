# module-automation

MQTT drivers and automations for EiN's devices. The `automation-bridge` service listens on an MQTT broker
and drives what it hears as devices under `/dev`: `ha-discovery` for anything that announces itself
the way Home Assistant reads (ESPHome, Zigbee2MQTT), `shelly` for Shelly's second generation and
later, `shelly-gen1` for the first (Plug S, 1, 1PM, 2.5, i3). Their readings and presses become the devices' endpoints, published on `dev.<device>.<endpoint>`
for queues and logs to take, and a value written to a control (`echo on > /dev/hall-plug/switch-0`)
is sent to the device.

Automations are nodes wired into a graph (inputs, logic, values, timers, actions), each a YAML
file under `/etc/automations` run as its owner, and a module's under `/etc/automations.d/<module>`.
This module's own is `automation/tour`, off: six small flows with every kind of node and invented
devices, to simulate in the editor or start one of your own from (`automation-new <name> --from tour`).
The `automation-engine` service runs them when a reading, a press, a device coming or going or the
clock says so; the Automations page draws and edits them, and `automations`, `automation-new`,
`automation-set` and `automation-check` do the same in the shell. The same service runs the
`virtual` driver: devices whose readings are worked out from other devices' (an average, the most,
whether any is on) and whose controls hold what is set.

Devices that are on the network but not yet on the broker are found too. A listener beside the
broker on the host's own network (EiN's deployment runs it with the broker) asks mDNS and SSDP
what is there and publishes each address it heard as a retained message under
`ein/discovery/host/<id>`, with its own `ein/discovery/status`. The bridge keeps those:
`automation-found` names each one (a Shelly, ESPHome, a HomeKit or Matter accessory, a Hue bridge,
a speaker, a printer, …), says whether it is a device already and, given one, shows all the
listener heard of it. `automation-adopt` adds one: a Shelly's MQTT is pointed at the broker and it
is restarted, so its driver takes it; anything else becomes a device of a driver that asks it
itself, over the network: `ipp` for a printer (state, warnings, ink and toner), `cast` for a Google
Cast speaker (what it plays; volume, mute, play, pause and stop), `snmp` for a NAS or anything
else that answers SNMP (uptime, load, memory, each volume's use, temperatures; the community is
`CFG_AUTOMATION_SNMP_COMMUNITY`), and `network` for the rest (whether it answers, and how fast).
`automation-snmp <host> [oid]` walks what a device's agent answers. The `http` driver asks a web
API that answers JSON, made by hand with `device-create <name> --driver http --config url=… --config
read=…`: a device on the network with an API of its own, the weather, the price of electricity, each
reading a path in the answer (`temperature=current.temperature_2m °C`,
`price=[time_start..time_end].SEK_per_kWh`), and `--config set=…` the controls, each an address asked
to set it (`pump=api/pump?run={value} 1/0`). `automation-ignore` leaves one out. The Devices page shows how
many can be added, and opens them as a page of their own.

The devices, their pages and the device commands are EiN core's; this module brings the drivers and
the automations.

An [EiN](https://github.com/einhq) module. It is developed and tested inside a checkout of EiN core,
as `modules/automation`, and a deployment chooses whether to run it.
