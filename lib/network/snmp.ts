/**
 * SNMPv2c over UDP, as much as reading a device takes: GET of named objects and a walk of a subtree
 * (GETBULK), their values decoded from BER. No SET: EiN only reads what a device says this way.
 * UDP is `node:dgram`'s, which Deno gives without the unstable flag its own UDP needs.
 */

import dgram from 'node:dgram';

/** A value as SNMP types it: numbers for the integer types, text for strings, dotted OIDs, `a.b.c.d` addresses. */
export type SnmpValue = number | bigint | string | null;

type SnmpVarbind = { oid: string; type: string; value: SnmpValue };

const TYPES: Record<number, string> = {
  0x02: 'INTEGER',
  0x04: 'STRING',
  0x05: 'NULL',
  0x06: 'OID',
  0x40: 'IpAddress',
  0x41: 'Counter32',
  0x42: 'Gauge32',
  0x43: 'TimeTicks',
  0x44: 'Opaque',
  0x46: 'Counter64',
  0x80: 'noSuchObject',
  0x81: 'noSuchInstance',
  0x82: 'endOfMibView',
};
const PDU = { get: 0xa0, response: 0xa2, bulk: 0xa5 };
const TIMEOUT_MS = 2500;

// ---- BER ----

const lengthOf = (length: number): number[] => {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
};

const tlv = (tag: number, body: number[]): number[] => [tag, ...lengthOf(body.length), ...body];

const integer = (value: number): number[] => {
  const bytes: number[] = [];
  let rest = value;
  do {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  } while (rest > 0 || (bytes[0] & 0x80) !== 0);
  return tlv(0x02, bytes);
};

const encodeOid = (oid: string): number[] => {
  const parts = oid.split('.').filter(Boolean).map(Number);
  if (parts.length < 2 || parts.some((part) => !Number.isInteger(part) || part < 0)) throw new Error(`'${oid}' is not an OID`);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    for (let rest = Math.floor(part / 128); rest > 0; rest = Math.floor(rest / 128)) chunk.unshift((rest & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, bytes);
};

/** A request: `kind` GET of `oids`, or GETBULK from them with `repetitions` each. */
const encodeRequest = (community: string, id: number, kind: 'get' | 'bulk', oids: string[], repetitions = 20): Uint8Array<ArrayBuffer> => {
  const varbinds = tlv(0x30, oids.flatMap((oid) => tlv(0x30, [...encodeOid(oid), 0x05, 0x00])));
  const pdu = tlv(kind === 'get' ? PDU.get : PDU.bulk, [...integer(id), ...integer(0), ...integer(kind === 'get' ? 0 : repetitions), ...varbinds]);
  return new Uint8Array(tlv(0x30, [...integer(1), ...tlv(0x04, [...new TextEncoder().encode(community)]), ...pdu]));
};

type Element = { tag: number; body: Uint8Array; end: number };

const read = (bytes: Uint8Array, at: number): Element => {
  const tag = bytes[at];
  let length = bytes[at + 1];
  let start = at + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[start + i];
    start += count;
  }
  if (start + length > bytes.length) throw new Error('the answer is cut short');
  return { tag, body: bytes.subarray(start, start + length), end: start + length };
};

const children = (body: Uint8Array): Element[] => {
  const out: Element[] = [];
  for (let at = 0; at < body.length;) {
    const element = read(body, at);
    out.push(element);
    at = element.end;
  }
  return out;
};

const decodeOid = (body: Uint8Array): string => {
  const parts = [Math.floor(body[0] / 40), body[0] % 40];
  let value = 0;
  for (const byte of body.subarray(1)) {
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join('.');
};

const unsigned = (body: Uint8Array): number => body.reduce((value, byte) => value * 256 + byte, 0);

const decodeValue = (element: Element): SnmpValue => {
  const { tag, body } = element;
  switch (tag) {
    case 0x02: {
      // Two's complement: a leading 1 bit makes it negative.
      const value = unsigned(body);
      return body[0] & 0x80 ? value - 256 ** body.length : value;
    }
    case 0x41:
    case 0x42:
    case 0x43:
      return unsigned(body);
    case 0x46:
      return body.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
    case 0x04:
    case 0x44:
      return new TextDecoder().decode(body);
    case 0x06:
      return decodeOid(body);
    case 0x40:
      return [...body].join('.');
    default:
      return null;
  }
};

/** A response's request id, error status and variable bindings. */
const decodeResponse = (bytes: Uint8Array): { id: number; error: number; varbinds: SnmpVarbind[] } => {
  const message = read(bytes, 0);
  const [, , pdu] = children(message.body);
  if (!pdu || pdu.tag !== PDU.response) throw new Error('the answer is not an SNMP response');
  const [id, error, , list] = children(pdu.body);
  const varbinds = children(list.body).map((varbind) => {
    const [name, value] = children(varbind.body);
    return { oid: decodeOid(name.body), type: TYPES[value.tag] ?? `0x${value.tag.toString(16)}`, value: decodeValue(value) };
  });
  return { id: unsigned(id.body), error: unsigned(error.body), varbinds };
};

// ---- requests ----

type SnmpTarget = { host: string; port?: number; community: string };

let nextId = Math.floor(Math.random() * 0x7fff_0000);

const exchange = (target: SnmpTarget, kind: 'get' | 'bulk', oids: string[]): Promise<SnmpVarbind[]> =>
  new Promise((resolve, reject) => {
    const id = (nextId = (nextId + 1) % 0x7fff_ffff);
    const socket = dgram.createSocket('udp4');
    const finish = (error?: Error, varbinds?: SnmpVarbind[]) => {
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(varbinds!);
    };
    // A wrong community is not answered at all, so it reads as silence.
    const timer = setTimeout(() => finish(new Error(`${target.host} does not answer SNMP with the community '${target.community}'`)), TIMEOUT_MS);
    socket.on('error', (error: Error) => finish(new Error(`cannot reach ${target.host}: ${error.message}`)));
    socket.on('message', (bytes: Uint8Array) => {
      try {
        const answer = decodeResponse(bytes);
        if (answer.id !== id) return;
        if (answer.error) finish(new Error(`${target.host} refused: SNMP error ${answer.error}`));
        else finish(undefined, answer.varbinds);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.send(encodeRequest(target.community, id, kind, oids), target.port ?? 161, target.host);
  });

/** The values of `oids`; one the device does not have is left out. */
export const snmpGet = async (target: SnmpTarget, oids: string[]): Promise<Map<string, SnmpValue>> => {
  const values = new Map<string, SnmpValue>();
  for (const varbind of await exchange(target, 'get', oids)) {
    if (!['noSuchObject', 'noSuchInstance', 'endOfMibView'].includes(varbind.type)) values.set(varbind.oid, varbind.value);
  }
  return values;
};

/** Every object under `root`, in order; at most `limit`. */
export const snmpWalk = async (target: SnmpTarget, root: string, limit = 5000): Promise<SnmpVarbind[]> => {
  const out: SnmpVarbind[] = [];
  const prefix = `${root.replace(/^\.|\.$/g, '')}.`;
  let from = root;
  while (out.length < limit) {
    const batch = await exchange(target, 'bulk', [from]);
    let done = batch.length === 0;
    for (const varbind of batch) {
      if (varbind.type === 'endOfMibView' || !varbind.oid.startsWith(prefix)) {
        done = true;
        break;
      }
      out.push(varbind);
      from = varbind.oid;
    }
    if (done) break;
  }
  return out;
};
