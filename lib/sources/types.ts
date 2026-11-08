/**
 * What a source tells the bridge, and what the bridge asks of a source.
 *
 * A source turns what a device says into `Update`s and a command into what the device
 * understands. It knows nothing of nodes or the bus: the sink (`lib/model.ts`) makes those of its
 * updates. Device and entity names are already slugs (`lib/slug.ts`).
 */

import type { EntityCategory, EntityKind, Value } from '../api.ts';

/** A device was announced, or said more about itself. */
export type DeviceUpdate = {
  kind: 'device';
  device: string;
  label: string;
  manufacturer?: string;
  model?: string;
  sw?: string;
  mac?: string;
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
  category?: EntityCategory;
  options?: string[];
  min?: number;
  max?: number;
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
  value: Value;
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

export type Update =
  | DeviceUpdate
  | EntityUpdate
  | StateUpdate
  | EventUpdate
  | OnlineUpdate
  | RetireUpdate
  | SubscribeUpdate
  | PublishUpdate;

/** One MQTT message to send. */
export type Publish = { topic: string; payload: string; retain?: boolean };

/** A value someone asked an entity for, normalized by `device-set`: `on`, `off`, `toggle`, a number, a word. */
export type Command = { device: string; entity: string; value: string; current?: Value };

/**
 * A source that listens on the bridge's MQTT connection.
 *
 * `decode` is given every message on the topics it subscribed to and on the topics it asked for
 * with a `subscribe` update; it ignores the ones that are not its. It may remember what it saw
 * (which topic is which entity's state), so one instance serves one connection.
 */
export interface MqttSource {
  readonly name: string;
  /** The topic filters it listens on from the start. */
  topics(): string[];
  decode(topic: string, payload: string, retained: boolean): Update[];
  /** What to send for a command to one of its entities; undefined when it is not its or cannot be set. */
  encode(command: Command): Publish[] | undefined;
  /** Whether a device is this source's. */
  owns(device: string): boolean;
  /**
   * Let go of a device: what it knows of it, and the messages to send so the broker stops
   * replaying the device's announcements (empty retained ones).
   */
  forget(device: string): Publish[];
}
