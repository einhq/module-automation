# module-automation

Rules for EiN's devices. Automations are nodes wired into a graph (inputs, logic, values, timers,
actions), each a YAML file under `/etc/automations` run as its owner, and a module's under
`/etc/automations.d/<module>`. A person's automation keeps its own scripts as children of its file
(`<name>.yaml/scripts/`), which a script node runs as the owner, with what is wired in as variables
and its `name=value` lines on its outputs. This module's own is `automation/tour`, off: nine small
flows with every kind of node and invented devices, to simulate in the editor or start one of your
own from (`automation-new <name> --from tour`).

The `automation-engine` service runs them when a reading, a press, a device coming or going, a file
coming into a folder or the clock says so; the Automations page draws and edits them, and
`automations`, `automation-new`, `automation-set` and `automation-check` do the same in the shell.
An automation acts on whatever is under `/dev`: core's own devices (a phone's tracker, a webhook,
the host), and those of any module that drives devices. The same service runs the `virtual` driver:
devices whose readings are worked out from other devices' (an average, the most, whether any is on)
and whose controls hold what is set.

The devices, their pages and the device commands are EiN core's; this module needs no service beside
EiN and no other module.

An [EiN](https://github.com/einhq) module. It is developed and tested inside a checkout of EiN core,
as `modules/automation`, and a deployment chooses whether to run it.
