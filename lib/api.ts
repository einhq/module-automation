/**
 * The answers of automation's commands, for other modules (`@automation/api`). Import-free on
 * purpose: a page imports it without pulling in the module's commands.
 */

/** `automation-status`: the bridge and its drivers, as this process sees them, and the rules. */
export type AutomationStatus = {
  /** False when the broker address is unset: only the devices asked over the network are read. */
  configured: boolean;
  url?: string;
  /** Whether the bridge runs in this process. */
  running: boolean;
  connected: boolean;
  /** Since when it has been connected, or disconnected. */
  since?: string;
  /** The drivers the bridge has registered with core, one per source it listens with: `ha-discovery`, `shelly`. */
  drivers: string[];
  /** The devices under /dev that automation's drivers drive, as the caller sees them. */
  devices: number;
  /** Their endpoints. */
  endpoints: number;
  /** MQTT messages heard since the bridge started. */
  messages: number;
  /** What the drivers cannot read, as `<device>/<entity>: why`. */
  unsupported: string[];
  lastError?: string;
  /** The rules service, when it runs in this process. */
  rules?: { count: number; runs: number; problems: string[] };
};

/** What an automation's messages carry: a device's reading, a word, a number. */
export type AutomationValue = number | string | boolean | null;

/** One node of an automation as its YAML says it: its kind, its settings, where it is and where it sends. */
export type AutomationNodeSpec = {
  type: string;
  label?: string;
  /** Its place on the canvas, `[x, y]`. */
  pos?: [number, number];
  /** The nodes it sends to: a list for its `out`, or a list per output (`true`, `false`, a switch's cases). */
  to?: string[] | Record<string, string[]>;
  [setting: string]: unknown;
};

/** An automation as its YAML says it. */
export type AutomationSpec = {
  description?: string;
  /** False to keep it from running; an `enabled` attr on its file says so too, and wins. */
  enabled?: boolean;
  nodes: Record<string, AutomationNodeSpec>;
};

/** What is wrong with an automation, and in which node. */
export type AutomationProblem = { node?: string; message: string };

/** What one node of a running automation last did. */
export type AutomationNodeStatus = {
  /** What it last sent. */
  value?: AutomationValue;
  /** When. */
  at?: string;
  /** When it will send next by itself: a timer's end, a delay's, a held value's. */
  due?: string;
  /** Why it did not do what it should: an action that failed, a value it waits for. */
  problem?: string;
  /** Messages that came to it. */
  messages: number;
};

/** `automation-rule-check`: a rule file as the rules service reads it, and what its conditions say now. */
export type RuleCheck = {
  name: string;
  path: string;
  /** The account its lines run as. */
  owner: string;
  /** Why the service does not run it. */
  problem?: string;
  description?: string;
  when?: string[];
  if?: { condition: string; holds: boolean }[];
  then?: string[];
  /** With `--run`: each line run, as the caller, until one failed. */
  ran?: { line: string; code: number }[];
};

/**
 * One address on the network as the network listener heard it, `ein/discovery/host/<id>` on the
 * broker: its mDNS services and SSDP answers, and its hardware address when the listener's host had
 * talked to it.
 */
export type NetworkHost = {
  ip: string;
  mac?: string;
  /** Its mDNS host names (`shellyplus1pm-a8032ab12345.local`). */
  names: string[];
  /** When the listener last heard it. */
  seen: string;
  mdns: { type: string; instance: string; port?: number; txt: Record<string, string> }[];
  ssdp: {
    st: string;
    usn?: string;
    server?: string;
    location?: string;
    friendlyName?: string;
    manufacturer?: string;
    modelName?: string;
    modelNumber?: string;
    serialNumber?: string;
    deviceType?: string;
    udn?: string;
  }[];
};

/** What a host on the network is. */
export type NetworkIdentity = {
  /** `shelly`, `shelly-gen1`, `esphome`, `tasmota`, `matter`, `homekit`, `hue`, `sonos`, `cast`, `airplay`, `printer`, `router`, `media`, `storage` or `other`. */
  kind: string;
  vendor?: string;
  label: string;
  model?: string;
  firmware?: string;
  serial?: string;
  /** What it would be as a device (`speaker`, `printer`), where its kind says. */
  class?: string;
  /** It can become a device of automation's, by `automation-adopt` or by hand as `connect` says. */
  addable: boolean;
  /**
   * The driver `automation-adopt` adds it with: a Shelly's, which it points at the broker, or one
   * that asks the device itself (`network`, `ipp`, `snmp`, `cast`). A host offered as `network` is
   * added as `snmp` when it answers SNMP.
   */
  adopt?: 'shelly' | 'shelly-gen1' | 'network' | 'ipp' | 'snmp' | 'cast';
  /** What adding it does, or what it takes. */
  connect?: string;
};

/** `automation-found`: a host on the network, what it is, and whether it is a device already. */
export type FoundDevice = NetworkIdentity & {
  /** Its hardware address without colons, else its IP: what `automation-adopt` and `automation-ignore` take. */
  id: string;
  ip: string;
  mac?: string;
  names: string[];
  seen: string;
  /** Its mDNS service types and SSDP device types. */
  services: string[];
  /** Its name under /dev, when it is a device already. */
  device?: string;
  ignored: boolean;
};

/** `automation-found`: the network listener, and what it found. */
export type FoundAnswer = {
  /** When the listener's last round was; absent when it has never been heard. */
  round?: string;
  /** The address devices reach the broker at, which `automation-adopt` gives them. */
  broker?: string;
  devices: FoundDevice[];
};

/**
 * `automation-adopt`: the driver it was added with. A Shelly was told the broker and restarts, and
 * becomes a device when it is back; any other is the device `device` at once.
 */
export type AdoptAnswer = { id: string; label: string; driver: string; broker?: string; restarted: boolean; device?: string };

/** `automation-found <id>`: one host, and everything the network listener heard of it. */
export type FoundDetail = FoundDevice & { host: NetworkHost };

/** `automation-snmp`: one object of a walk, its value as text when it is a 64-bit counter. */
export type SnmpObject = { oid: string; type: string; value: string | number | null };
