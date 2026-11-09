/**
 * IPP's Get-Printer-Attributes (RFC 8011) over HTTP: what a network printer says of its state and
 * supplies. Only what a reading needs is decoded: integers, enums, booleans and the text types; any
 * other value is left out.
 */

import type { Fetch } from './adopt.ts';

/** An attribute's values, by name. */
type IppAttributes = Record<string, (string | number | boolean)[]>;

const TAG = { operation: 0x01, end: 0x03, integer: 0x21, boolean: 0x22, enum: 0x23, textLang: 0x35, nameLang: 0x36, keyword: 0x44, uri: 0x45, charset: 0x47, language: 0x48 };

/** What `getPrinterAttributes` asks for. */
const WANTED = [
  'printer-state',
  'printer-state-reasons',
  'printer-state-message',
  'printer-make-and-model',
  'printer-firmware-string-version',
  'marker-names',
  'marker-levels',
  'marker-colors',
  'marker-types',
  'printer-impressions-completed',
  'printer-uuid',
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const attribute = (tag: number, name: string, values: string[]): number[] => {
  const bytes: number[] = [];
  values.forEach((value, index) => {
    const key = index === 0 ? encoder.encode(name) : new Uint8Array();
    const data = encoder.encode(value);
    bytes.push(tag, key.length >> 8, key.length & 0xff, ...key, data.length >> 8, data.length & 0xff, ...data);
  });
  return bytes;
};

/** A Get-Printer-Attributes request for the printer at `uri`. */
export const printerAttributesRequest = (uri: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array([
    2,
    0,
    0x00,
    0x0b,
    0,
    0,
    0,
    1,
    TAG.operation,
    ...attribute(TAG.charset, 'attributes-charset', ['utf-8']),
    ...attribute(TAG.language, 'attributes-natural-language', ['en']),
    ...attribute(TAG.uri, 'printer-uri', [uri]),
    ...attribute(TAG.keyword, 'requested-attributes', WANTED),
    TAG.end,
  ]);

/** The attributes of an IPP response, every group together; throws on a status that is not success. */
export const parseIppResponse = (body: Uint8Array): IppAttributes => {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (body.length < 9) throw new Error('the printer answered too little to be IPP');
  const status = view.getUint16(2);
  if (status >= 0x0100) throw new Error(`the printer refused: IPP status 0x${status.toString(16).padStart(4, '0')}`);
  const attributes: IppAttributes = {};
  let name = '';
  let offset = 8;
  while (offset < body.length) {
    const tag = body[offset++];
    if (tag === TAG.end) break;
    if (tag < 0x10) continue;
    const nameLength = view.getUint16(offset);
    offset += 2;
    if (nameLength > 0) name = decoder.decode(body.subarray(offset, offset + nameLength));
    offset += nameLength;
    const length = view.getUint16(offset);
    offset += 2;
    const data = body.subarray(offset, offset + length);
    offset += length;
    let value: string | number | boolean | undefined;
    if ((tag === TAG.integer || tag === TAG.enum) && length === 4) value = new DataView(data.buffer, data.byteOffset, 4).getInt32(0);
    else if (tag === TAG.boolean && length === 1) value = data[0] !== 0;
    else if (tag === TAG.textLang || tag === TAG.nameLang) {
      const languageLength = (data[0] << 8) | data[1];
      const at = 2 + languageLength;
      value = decoder.decode(data.subarray(at + 2, at + 2 + ((data[at] << 8) | data[at + 1])));
    } else if (tag >= 0x40 && tag <= 0x4f) value = decoder.decode(data);
    if (value === undefined) continue;
    (attributes[name] ??= []).push(value);
  }
  return attributes;
};

/** What the printer at `ip` says of itself; `path` is its IPP resource (`ipp/print`). */
export const getPrinterAttributes = async (fetcher: Fetch, ip: string, port = 631, path = 'ipp/print'): Promise<IppAttributes> => {
  const uri = `ipp://${ip}:${port}/${path.replace(/^\/+/, '')}`;
  const response = await fetcher(`http://${ip}:${port}/${path.replace(/^\/+/, '')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/ipp' },
    body: printerAttributesRequest(uri),
    signal: AbortSignal.timeout(8000),
  });
  const body = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) throw new Error(`the printer answered ${response.status}`);
  return parseIppResponse(body);
};
