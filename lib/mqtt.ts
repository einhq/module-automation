/**
 * The bridge's view of an MQTT connection: connect, subscribe, publish, hear messages and hear it
 * close. `connectMqtt` makes one over TCP or TLS; tests hand the bridge a broker of their own.
 *
 * A connection is used once: it never reconnects by itself, so the bridge makes a new one after
 * `closed` resolves.
 */

import { Mqtt, MqttClient } from 'mqtt5';

export type MqttMessage = { topic: string; payload: string; retained: boolean };

export interface MqttConnection {
  subscribe(filters: string[]): Promise<void>;
  publish(topic: string, payload: string, options?: { retain?: boolean }): Promise<void>;
  /** Resolves when the connection is lost or closed. */
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export type MqttConnect = (onMessage: (message: MqttMessage) => void) => Promise<MqttConnection>;

type MqttOptions = {
  url: string;
  clientId: string;
  username?: string;
  password?: string;
};

const decoder = new TextDecoder();

/** A connection to the broker at `options.url` (`mqtt://` or `mqtts://`), MQTT 3.1.1. */
export const connectMqtt = (options: MqttOptions): MqttConnect => async (onMessage) => {
  const client = new MqttClient({
    url: new URL(options.url),
    clientId: options.clientId,
    username: options.username || undefined,
    password: options.password || undefined,
    protocolVersion: Mqtt.ProtocolVersion.MQTT_V3_1_1,
    keepAlive: 30,
    clean: true,
  });
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => markClosed = resolve);
  client.on('closed', () => markClosed());
  client.on('publish', (event) => {
    const packet = event.detail;
    onMessage({ topic: packet.topic, payload: decoder.decode(packet.payload), retained: Boolean(packet.retain) });
  });
  const answer = await client.connect();
  if (answer && typeof answer === 'object' && 'returnCode' in answer && answer.returnCode !== 0) {
    markClosed();
    throw new Error(`the broker refused the connection (code ${answer.returnCode})`);
  }
  return {
    closed,
    subscribe: async (filters) => {
      for (const filter of filters) await client.subscribe(filter, Mqtt.QoS.AT_MOST_ONCE);
    },
    publish: async (topic, payload, publishOptions) => {
      await client.publish(topic, payload, { qos: Mqtt.QoS.AT_MOST_ONCE, retain: publishOptions?.retain ?? false });
    },
    close: async () => {
      await client.disconnect().catch(() => {});
      markClosed();
    },
  };
};
