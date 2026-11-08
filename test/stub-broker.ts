/**
 * A broker for tests: MQTT 3.1.1 over TCP on a port of its own, QoS 0 and 1 in, QoS 0 out, retained
 * messages, `+` and `#` filters. It keeps every message a client published, so a test can see what
 * the bridge sent, and can publish as a device would and drop its clients as a restart would.
 */

export type BrokerMessage = { topic: string; payload: string; retain: boolean };

export type StubBroker = {
  url: string;
  /** What clients published, in order. */
  published: BrokerMessage[];
  /** The retained messages, by topic. */
  retained: Map<string, string>;
  /** Publish as a device would. */
  publish(topic: string, payload: string, options?: { retain?: boolean }): void;
  /** How many clients are connected. */
  clients(): number;
  /** Close every client's connection, as a broker restart does. */
  dropClients(): void;
  close(): Promise<void>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const topicMatches = (filter: string, topic: string): boolean => {
  const want = filter.split('/');
  const have = topic.split('/');
  for (let i = 0; i < want.length; i++) {
    if (want[i] === '#') return true;
    if (i >= have.length) return false;
    if (want[i] !== '+' && want[i] !== have[i]) return false;
  }
  return want.length === have.length;
};

const remainingLength = (length: number): number[] => {
  const bytes: number[] = [];
  do {
    let byte = length % 128;
    length = Math.floor(length / 128);
    if (length > 0) byte |= 0x80;
    bytes.push(byte);
  } while (length > 0);
  return bytes;
};

const packet = (header: number, body: Uint8Array): Uint8Array => new Uint8Array([header, ...remainingLength(body.length), ...body]);

const string = (text: string): number[] => {
  const bytes = encoder.encode(text);
  return [bytes.length >> 8, bytes.length & 0xff, ...bytes];
};

const publishPacket = (topic: string, payload: string, retain: boolean): Uint8Array =>
  packet(0x30 | (retain ? 1 : 0), new Uint8Array([...string(topic), ...encoder.encode(payload)]));

type Client = { conn: Deno.TcpConn; filters: string[]; closed: boolean };

export const startStubBroker = (): StubBroker => {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const clients = new Set<Client>();
  const published: BrokerMessage[] = [];
  const retained = new Map<string, string>();

  const send = (client: Client, bytes: Uint8Array) => {
    if (client.closed) return;
    client.conn.write(bytes).catch(() => drop(client));
  };

  const drop = (client: Client) => {
    if (client.closed) return;
    client.closed = true;
    clients.delete(client);
    try {
      client.conn.close();
    } catch {
      // already closed
    }
  };

  const deliver = (topic: string, payload: string) => {
    for (const client of clients) {
      if (client.filters.some((filter) => topicMatches(filter, topic))) send(client, publishPacket(topic, payload, false));
    }
  };

  const accept = (topic: string, payload: string, retain: boolean) => {
    if (retain) {
      if (payload === '') retained.delete(topic);
      else retained.set(topic, payload);
    }
    deliver(topic, payload);
  };

  const handle = (client: Client, header: number, body: Uint8Array) => {
    const type = header >> 4;
    if (type === 1) {
      send(client, new Uint8Array([0x20, 0x02, 0x00, 0x00]));
    } else if (type === 3) {
      const qos = (header >> 1) & 0x03;
      const topicLength = (body[0] << 8) | body[1];
      const topic = decoder.decode(body.subarray(2, 2 + topicLength));
      let offset = 2 + topicLength;
      if (qos > 0) {
        send(client, new Uint8Array([0x40, 0x02, body[offset], body[offset + 1]]));
        offset += 2;
      }
      const payload = decoder.decode(body.subarray(offset));
      const retain = (header & 0x01) === 1;
      published.push({ topic, payload, retain });
      accept(topic, payload, retain);
    } else if (type === 8) {
      const granted: number[] = [];
      let offset = 2;
      const added: string[] = [];
      while (offset < body.length) {
        const length = (body[offset] << 8) | body[offset + 1];
        added.push(decoder.decode(body.subarray(offset + 2, offset + 2 + length)));
        offset += 2 + length + 1;
        granted.push(0);
      }
      client.filters.push(...added);
      send(client, packet(0x90, new Uint8Array([body[0], body[1], ...granted])));
      for (const [topic, payload] of retained) {
        if (added.some((filter) => topicMatches(filter, topic))) send(client, publishPacket(topic, payload, true));
      }
    } else if (type === 12) {
      send(client, new Uint8Array([0xd0, 0x00]));
    } else if (type === 14) {
      drop(client);
    }
  };

  const serve = async (client: Client) => {
    let buffer = new Uint8Array(0);
    const chunk = new Uint8Array(64 * 1024);
    while (!client.closed) {
      let read: number | null;
      try {
        read = await client.conn.read(chunk);
      } catch {
        break;
      }
      if (read === null) break;
      const joined = new Uint8Array(buffer.length + read);
      joined.set(buffer);
      joined.set(chunk.subarray(0, read), buffer.length);
      buffer = joined;
      while (buffer.length >= 2) {
        let length = 0;
        let multiplier = 1;
        let index = 1;
        let complete = false;
        while (index < buffer.length && index <= 4) {
          const byte = buffer[index++];
          length += (byte & 0x7f) * multiplier;
          multiplier *= 128;
          if ((byte & 0x80) === 0) {
            complete = true;
            break;
          }
        }
        if (!complete || buffer.length < index + length) break;
        handle(client, buffer[0], buffer.subarray(index, index + length));
        buffer = buffer.slice(index + length);
      }
    }
    drop(client);
  };

  const accepting = (async () => {
    for await (const conn of listener) {
      const client: Client = { conn, filters: [], closed: false };
      clients.add(client);
      serve(client);
    }
  })().catch(() => {});

  return {
    url: `mqtt://127.0.0.1:${port}`,
    published,
    retained,
    publish: (topic, payload, options) => accept(topic, payload, options?.retain ?? false),
    clients: () => clients.size,
    dropClients: () => {
      for (const client of [...clients]) drop(client);
    },
    close: async () => {
      for (const client of [...clients]) drop(client);
      listener.close();
      await accepting;
    },
  };
};
