# module-automation

Devices, readings, queues and rules: sensors, buttons and switches over MQTT, each reading kept as
history and published on EiN's routing keys, where queues, logs and rules pick it up.

An [EiN](https://github.com/einhq) module. It is developed and tested inside a checkout of EiN core,
as `modules/automation`, and a deployment chooses whether to run it.
