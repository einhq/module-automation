/**
 * What a source tells the bridge, and what the bridge asks of a source.
 *
 * A source turns what a device says into `Update`s and a command into what the device
 * understands. It knows nothing of nodes or the bus: the bridge's device writer (`lib/drivers.ts`)
 * makes devices and endpoints of its updates. Device and entity names are already names core
 * takes (`deviceName`).
 */

import type { DeviceValue, EndpointCategory } from '@ein/api';

/**
 * What one entity of a device is:
 *
 * - `sensor` — a reading, a number with a unit or a word
 * - `binary` — something on or off that is only read: a door, motion, an input
 * - `switch` — on or off, and can be switched
 * - `light` — a switch that is a light
 * - `number` — a number that can be set
 * - `text` — a word that can be chosen, from `options` when there are some
 * - `color` — a colour that can be set, as `#rrggbb`
 * - `button` — a physical button: its presses are events, not a state
 * - `action` — something that can be done, with no state: a restart, a doorbell's chime
 */
export type EntityKind = 'sensor' | 'binary' | 'switch' | 'light' | 'number' | 'text' | 'color' | 'button' | 'action';

/** A device was announced, or said more about itself. */
export type DeviceUpdate = {
  kind: 'device';
  device: string;
  label: string;
  manufacturer?: string;
  model?: string;
  firmware?: string;
  mac?: string;
  /** Its own web page. */
  url?: string;
};

/** An entity of a device was announced. */
export type EntityUpdate = {
  kind: 'entity';
  device: string;
  entity: string;
  label: string;
  entityKind: EntityKind;
  unit?: string;
  deviceClass?: string;
  category?: EndpointCategory;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  settable: boolean;
  supported: boolean;
  /** Why it is not supported. */
  problem?: string;
};

/** An entity's state. */
type StateUpdate = {
  kind: 'state';
  device: string;
  entity: string;
  value: DeviceValue;
  retained: boolean;
};

/** A button was pressed: `value` is how (`single`, `double`, `long`, …). */
type EventUpdate = {
  kind: 'event';
  device: string;
  entity: string;
  value: string;
};

/** A device came online or went away. */
type OnlineUpdate = {
  kind: 'online';
  device: string;
  online: boolean;
};

/** A device stopped announcing an entity. */
type RetireUpdate = {
  kind: 'retire';
  device: string;
  entity: string;
};

/** The source wants messages on a topic it just learned of, such as a state topic. */
type SubscribeUpdate = {
  kind: 'subscribe';
  topic: string;
};

/** The source wants to say something to a device, such as ask what it is. */
type PublishUpdate = {
  kind: 'publish';
  publish: Publish;
};

/** What a source says of its devices, which the device writer applies. */
export type DeviceChange = DeviceUpdate | EntityUpdate | StateUpdate | EventUpdate | OnlineUpdate | RetireUpdate;

export type Update = DeviceChange | SubscribeUpdate | PublishUpdate;

/** One MQTT message to send. */
export type Publish = { topic: string; payload: string; retain?: boolean };

/** A value written to an entity, as text: `on`, `off`, a number, a word, `press`. */
export type Command = { device: string; entity: string; value: string };

/**
 * A source that listens on the bridge's MQTT connection, and the driver of the devices it finds.
 *
 * `decode` is given every message on the topics it subscribed to and on the topics it asked for
 * with a `subscribe` update; it ignores the ones that are not its. It may remember what it saw
 * (which topic is which entity's state), so one instance serves one connection.
 */
export interface MqttSource {
  /** Its name, which is its driver's: `ha-discovery`, `shelly`. */
  readonly name: string;
  /** What its driver is, as `devices --drivers` says it. */
  readonly description: string;
  /** The topic filters it listens on from the start. */
  topics(): string[];
  decode(topic: string, payload: string, retained: boolean): Update[];
  /** What to send for a command to one of its entities; undefined when it is not its or cannot be set. */
  encode(command: Command): Publish[] | undefined;
  /**
   * Let go of a device: what it knows of it, and the messages to send so the broker stops
   * replaying the device's announcements (empty retained ones).
   */
  forget(device: string): Publish[];
}
