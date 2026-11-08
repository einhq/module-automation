# automation-bridge — hears devices on the MQTT broker and sends what device-set asks. Ends at once,
# saying so, while CFG_AUTOMATION_MQTT_URL is empty. The automation group, whose members change
# devices and rules, is made here the first time.
group-exists automation || group-create automation --title Automation --description "May name, forget and write rules for the devices under /archive/devices"
automation-bridge
