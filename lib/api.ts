/**
 * The answers of automation's commands, for its pages and for other modules (`@automation/api`).
 * Import-free on purpose: a page imports it without pulling in the module's commands.
 */

/**
 * What one entity of a device is:
 *
 * - `sensor` — a reading, a number with a unit or a word
 * - `binary` — something on or off that is only read: a door, motion, an input
 * - `switch` — on or off, and can be switched
 * - `light` — a switch that is a light
 * - `number` — a number that can be set
 * - `text` — a word that can be chosen, from `options` when there are some
 * - `button` — a physical button: its presses are events, not a state
 * - `action` — something that can be done, with no state: a restart, a doorbell's chime
 * - `position` — where it is: its history is a track of GPS fixes, not a log
 */
export type EntityKind = 'sensor' | 'binary' | 'switch' | 'light' | 'number' | 'text' | 'button' | 'action' | 'position';

/** What an entity is about, when it is not the house itself (Home Assistant's entity category). */
export type EntityCategory = 'diagnostic' | 'config';

/** A value as the bus carries it and the history keeps it. */
export type Value = number | string | boolean | null;

/**
 * One reading or press as it is published on the bus and appended to an entity's history. It says
 * whose it is, since a queue hands out a message without the key it came on.
 */
export type Reading = {
  device: string;
  entity: string;
  /** `state` for a reading or a state, `event` for a press. */
  kind: 'state' | 'event';
  value: Value;
  unit?: string;
  /** When the bridge received it (ISO 8601). */
  at: string;
  /** Set when a broker replayed the device's last message after a reconnect. */
  retained?: true;
};

/** A device coming online or going away, as it is published on `automation.online.<device>`. */
export type OnlineMessage = { device: string; online: boolean; at: string };

/** Attrs of a `device` node. */
export type DeviceAttrs = {
  /** What it is called, as the device itself or a person named it. */
  label: string;
  /** The source that found it: `ha-discovery`, `shelly`. */
  source: string;
  manufacturer?: string;
  model?: string;
  /** Firmware version. */
  sw?: string;
  mac?: string;
  /** Whether it answers, when its source can tell. */
  online?: boolean;
};

/** Attrs of an `entity` node. */
export type EntityAttrs = {
  label: string;
  kind: EntityKind;
  unit?: string;
  /** What is measured, in Home Assistant's words: `temperature`, `power`, `door`. */
  deviceClass?: string;
  /** Choices of a `text` entity that can be set. */
  options?: string[];
  min?: number;
  max?: number;
  /**
   * `diagnostic` for what tells of the device rather than the house (its own temperature, its
   * signal), `config` for a setting of the device; unset for the rest.
   */
  category?: EntityCategory;
  /** Shortest time between two published readings, in seconds; the setting's when unset. */
  minInterval?: number;
  /** False when the bridge cannot read its values (a template it does not understand). */
  supported?: boolean;
  /** Set when the device stopped announcing it; its history stays. */
  retired?: boolean;
};

/** Attrs of a `set` node (type `automation-set`): the last command someone gave. */
export type SetAttrs = {
  value?: string;
  /** Distinguishes two commands of the same value. */
  id?: string;
  at?: string;
};

/** An entity with its latest value, as `device-show` answers. */
export type EntitySummary = {
  name: string;
  path: string;
  label: string;
  kind: EntityKind;
  unit?: string;
  deviceClass?: string;
  category?: EntityCategory;
  options?: string[];
  min?: number;
  max?: number;
  supported: boolean;
  retired: boolean;
  /** Whether `device-set` takes a value for it. */
  settable: boolean;
  last?: { value: Value; at: string };
  /** A position's track: its path, how many fixes it holds and when the last was. */
  track?: { path: string; points: number; lastAt?: string };
};

/** A device, as `devices` answers. */
export type DeviceSummary = {
  name: string;
  path: string;
  label: string;
  source: string;
  manufacturer?: string;
  model?: string;
  online?: boolean;
  entities: number;
  /** When the latest of its readings arrived. */
  lastAt?: string;
  /**
   * The reading a card shows: a temperature, then power, humidity, light or energy, else any
   * sensor, else a switch or a light; never one about the device itself.
   */
  main?: { entity: string; label: string; value: Value; unit?: string };
};

/** `device-show`: a device and every entity of it. */
export type DeviceInfo = DeviceSummary & {
  sw?: string;
  mac?: string;
  entityList: EntitySummary[];
};

/** `device-create`: the device made, and its position's track when it has one. */
export type DeviceCreated = {
  device: string;
  path: string;
  /** The track its position is kept in. */
  track?: string;
};

/** `device-tracker`: whether a phone or GPS tracker may post the device's position, and where. */
export type DeviceTracker = {
  device: string;
  /** The track its position is kept in. */
  track: string;
  enabled: boolean;
  /** The server URL a phone is given, `<origin>/tracker/<id>.<token>`, or its path without `--origin`; absent while turned off. */
  url?: string;
  /** What the QR code says: the URL with the device's name as Traccar Client's device identifier. */
  qrText?: string;
  /** The QR code as an SVG document; only with `--origin`. */
  qrSvg?: string;
};

/** `device-set`: what was asked of which entity. */
export type DeviceSetResult = {
  device: string;
  entity: string;
  value: string;
};

/** How `device-history --bucket` sums each interval up. */
export type HistoryAggregate = 'avg' | 'min' | 'max' | 'sum' | 'count' | 'first' | 'last';

/**
 * `device-history`: one entity's readings, oldest first; with `--bucket`, one per interval, where
 * `at` is the interval's start, `value` its readings summed up and `count` how many there were.
 */
export type DeviceHistory = {
  device: string;
  entity: string;
  unit?: string;
  bucket?: { seconds: number; aggregate: HistoryAggregate };
  readings: { at: string; value: Value; count?: number }[];
};

/** `automation-status`: the bridge, as this process sees it. */
export type AutomationStatus = {
  /** False when the broker address is unset: automation is off. */
  configured: boolean;
  url?: string;
  /** Whether the bridge runs in this process. */
  running: boolean;
  connected: boolean;
  /** Since when it has been connected, or disconnected. */
  since?: string;
  sources: string[];
  devices: number;
  entities: number;
  messages: number;
  /** Entities whose values the bridge cannot read, as `<device>/<entity>: why`. */
  unsupported: string[];
  lastError?: string;
  /** The rules service, when it runs in this process. */
  rules?: { count: number; runs: number; problems: string[] };
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
