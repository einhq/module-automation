# module-automation

MQTT drivers and rules for EiN's devices. The `automation-bridge` service listens on an MQTT broker
and drives what it hears as devices under `/dev`: `ha-discovery` for anything that announces itself
the way Home Assistant reads (ESPHome, Zigbee2MQTT), `shelly` for Shelly's second generation and
later. Their readings and presses become the devices' endpoints, published on `dev.<device>.<endpoint>`
for queues and logs to take, and a value written to a control (`echo on > /dev/hall-plug/switch-0`)
is sent to the device. The `automation-rules` service runs the rules under `/etc/automation/rules`
when a reading, a press, a device coming or going or the clock says so.

The devices, their pages and the device commands are EiN core's; this module brings the drivers and
the rules.

An [EiN](https://github.com/einhq) module. It is developed and tested inside a checkout of EiN core,
as `modules/automation`, and a deployment chooses whether to run it.
