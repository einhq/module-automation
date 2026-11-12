/**
 * An ONVIF camera, asked over SOAP at its device service (`http://camera/onvif/device_service`):
 * what it is, where its media, events and PTZ services are, its profiles with the RTSP address and
 * still picture of each, its events by PullPoint, and its presets and moves.
 *
 * Every request but the camera's clock is signed with a WS-Security UsernameToken: the password is
 * sent only as a digest of itself, a nonce and the time, which the camera checks against its own
 * clock. The time is the camera's, from the first answer of its clock, since one whose clock is off
 * by a minute refuses a token made with ours. Every address the camera gives is taken at the host
 * its device service was reached at, as a camera may name itself by an address of its own.
 */

import type { Fetch } from '../network/adopt.ts';
import { child, escapeXml, find, findAll, parseXml, textOf, writeXml, type XmlElement } from './xml.ts';

const NS = {
  device: 'http://www.onvif.org/ver10/device/wsdl',
  media: 'http://www.onvif.org/ver10/media/wsdl',
  events: 'http://www.onvif.org/ver10/events/wsdl',
  ptz: 'http://www.onvif.org/ver20/ptz/wsdl',
  schema: 'http://www.onvif.org/ver10/schema',
  wsnt: 'http://docs.oasis-open.org/wsn/b-2',
};

const WSSE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const WSU = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
const DIGEST = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';
const BASE64 = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';

const TIMEOUT_MS = 10_000;

/** What the camera says it is. */
type OnvifInfo = { manufacturer?: string; model?: string; firmware?: string; serial?: string };

/** Where the camera's services are; a service it lacks is unset. */
type OnvifServices = { media?: string; events?: string; ptz?: string };

/** One of the camera's profiles: a stream it sends, and whether it turns. */
export type OnvifProfile = {
  token: string;
  name?: string;
  /** `h264`, `h265` or `mjpeg`. */
  codec?: string;
  width?: number;
  height?: number;
  fps?: number;
  /** Set when the profile turns the camera: whether it pans and tilts, and zooms. */
  ptz?: { panTilt: boolean; zoom: boolean };
};

/** A PullPoint the camera keeps its events in for EiN: its address, and what each request to it carries. */
export type OnvifSubscription = { address: string; parameters: string };

/** One message from a PullPoint: its topic, without prefixes, and its data's items. */
export type OnvifMessage = { topic: string; data: Record<string, string> };

/** A camera's refusal: its fault's code (`NotAuthorized`) and reason. */
export class OnvifFault extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

/** The device service's address: as given when it is one, else at the address given, on ONVIF's usual path. */
export const deviceServiceUrl = (address: string): string => {
  const trimmed = address.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed.replace(/\/+$/, '')}/onvif/device_service`;
};

const ENCODINGS: Record<string, string> = { H264: 'h264', H265: 'h265', HEVC: 'h265', JPEG: 'mjpeg' };

const number = (text: string | undefined): number | undefined => {
  const value = Number(text);
  return text && Number.isFinite(value) ? value : undefined;
};

/** The profiles in a `GetProfiles` answer that send video. */
const readProfiles = (body: XmlElement): OnvifProfile[] =>
  findAll(body, 'Profiles').flatMap((profile) => {
    const token = profile.attrs.token;
    const encoder = child(profile, 'VideoEncoderConfiguration');
    if (!token || !encoder) return [];
    const resolution = child(encoder, 'Resolution');
    const ptz = child(profile, 'PTZConfiguration');
    const codec = ENCODINGS[textOf(encoder, 'Encoding')?.toUpperCase() ?? ''];
    const width = number(textOf(resolution, 'Width'));
    const height = number(textOf(resolution, 'Height'));
    const fps = number(textOf(child(encoder, 'RateControl'), 'FrameRateLimit'));
    const name = child(profile, 'Name')?.text.trim();
    return [{
      token,
      ...(name ? { name } : {}),
      ...(codec ? { codec } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(fps ? { fps } : {}),
      ...(ptz ? { ptz: { panTilt: !!child(ptz, 'DefaultContinuousPanTiltVelocitySpace'), zoom: !!child(ptz, 'DefaultContinuousZoomVelocitySpace') } } : {}),
    }];
  });

/** The topics in a `GetEventProperties` answer, as paths without prefixes (`RuleEngine/CellMotionDetector/Motion`). */
const readTopics = (body: XmlElement): string[] => {
  const set = find(body, 'TopicSet');
  const out: string[] = [];
  const walk = (element: XmlElement, path: string[]) => {
    for (const each of element.children) {
      const here = [...path, each.name];
      if (each.attrs.topic === 'true') out.push(here.join('/'));
      if (each.name !== 'MessageDescription') walk(each, here);
    }
  };
  if (set) walk(set, []);
  return out;
};

/** The messages in a `PullMessages` answer. */
const readMessages = (body: XmlElement): OnvifMessage[] =>
  findAll(body, 'NotificationMessage').map((notification) => {
    const topic = (textOf(notification, 'Topic') ?? '').split('/').map((part) => part.slice(part.indexOf(':') + 1)).join('/');
    const outer = child(notification, 'Message');
    const message = child(outer, 'Message') ?? outer;
    const data: Record<string, string> = {};
    for (const item of findAll(child(message, 'Data'), 'SimpleItem')) if (item.attrs.Name) data[item.attrs.Name] = item.attrs.Value ?? '';
    return { topic, data };
  });

/** The camera's clock, from a `GetSystemDateAndTime` answer; undefined when it does not say. */
const readClock = (body: XmlElement): Date | undefined => {
  const utc = find(body, 'UTCDateTime');
  const date = child(utc, 'Date');
  const time = child(utc, 'Time');
  const parts = [textOf(date, 'Year'), textOf(date, 'Month'), textOf(date, 'Day'), textOf(time, 'Hour'), textOf(time, 'Minute'), textOf(time, 'Second')].map(number);
  if (parts.some((part) => part === undefined)) return undefined;
  const [year, month, day, hour, minute, second] = parts as number[];
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
};

const bytesToBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

/** A UsernameToken's password digest: Base64(SHA-1(nonce + created + password)). */
export const passwordDigest = async (nonce: Uint8Array, created: string, password: string): Promise<string> => {
  const text = new TextEncoder().encode(created + password);
  const joined = new Uint8Array(nonce.length + text.length);
  joined.set(nonce);
  joined.set(text, nonce.length);
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest('SHA-1', joined)));
};

export type Onvif = ReturnType<typeof createOnvif>;

/** A camera's ONVIF services at `address` (its device service, or the host it is at), as `user` with `password`. */
export const createOnvif = (fetcher: Fetch, address: string, user: string, password: string) => {
  const device = deviceServiceUrl(address);
  const hostname = new URL(device).hostname;
  /** The camera's clock less ours, once it has said it. */
  let offset: number | undefined;
  let services: Promise<OnvifServices> | undefined;

  /** An address the camera gave, at the host the device service is reached at. */
  const atHost = (url: string): string => {
    try {
      const parsed = new URL(url);
      parsed.hostname = hostname;
      return parsed.toString();
    } catch {
      return url;
    }
  };

  const security = async (): Promise<string> => {
    if (!user) return '';
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const created = new Date(Date.now() + (offset ?? 0)).toISOString().replace(/\.\d+Z$/, 'Z');
    return `<wsse:Security s:mustUnderstand="1" xmlns:wsse="${WSSE}" xmlns:wsu="${WSU}"><wsse:UsernameToken>` +
      `<wsse:Username>${escapeXml(user)}</wsse:Username>` +
      `<wsse:Password Type="${DIGEST}">${await passwordDigest(nonce, created, password)}</wsse:Password>` +
      `<wsse:Nonce EncodingType="${BASE64}">${bytesToBase64(nonce)}</wsse:Nonce>` +
      `<wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security>`;
  };

  type CallOptions = { signed?: boolean; action?: string; to?: string; parameters?: string; timeoutMs?: number; signal?: AbortSignal };

  /** One SOAP request: its body's answer, or the camera's fault thrown. */
  const call = async (url: string, body: string, options: CallOptions = {}): Promise<XmlElement> => {
    if (options.signed !== false && offset === undefined) await clock();
    const addressing = options.action
      ? `<a:Action>${escapeXml(options.action)}</a:Action>${options.to ? `<a:To>${escapeXml(options.to)}</a:To>` : ''}${options.parameters ?? ''}`
      : '';
    const envelope = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing">` +
      `<s:Header>${options.signed === false ? '' : await security()}${addressing}</s:Header><s:Body>${body}</s:Body></s:Envelope>`;
    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': `application/soap+xml; charset=utf-8${options.action ? `; action="${options.action}"` : ''}` },
      body: envelope,
      signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]),
    }).catch((error) => {
      throw new Error(`cannot reach ${new URL(url).host}: ${error instanceof Error ? error.message : error}`);
    });
    const text = await response.text();
    let doc: XmlElement | undefined;
    try {
      doc = parseXml(text);
    } catch {
      // An answer that is not SOAP: its status says what went wrong.
    }
    const fault = find(doc, 'Fault');
    if (fault) {
      const codes = findAll(find(fault, 'Code'), 'Value').map((value) => value.text.trim().replace(/^.*:/, ''));
      const code = codes.at(-1);
      const reason = textOf(find(fault, 'Reason'), 'Text') ?? textOf(fault, 'faultstring');
      if (code === 'NotAuthorized' || code === 'FailedAuthentication' || response.status === 401) {
        throw new OnvifFault(`the camera refused ${user || 'a request without a user'}${user ? "'s password" : ''}`, 'NotAuthorized');
      }
      throw new OnvifFault(`the camera answered ${reason ?? code ?? 'a fault'}`, code);
    }
    if (response.status === 401) throw new OnvifFault(`the camera refused ${user || 'a request without a user'}${user ? "'s password" : ''}`, 'NotAuthorized');
    if (!response.ok || !doc) throw new Error(`the camera answered ${response.status}${doc ? '' : ', not in SOAP'}`);
    const answer = find(doc, 'Body');
    if (!answer) throw new Error('the camera answered without a body');
    return answer;
  };

  /** The camera's clock less ours, asked once; nought when the camera does not say. */
  const clock = async (): Promise<void> => {
    try {
      const at = readClock(await call(device, `<GetSystemDateAndTime xmlns="${NS.device}"/>`, { signed: false }));
      offset = at ? at.getTime() - Date.now() : 0;
    } catch {
      offset = 0;
    }
  };

  const servicesOf = async (): Promise<OnvifServices> => {
    const body = await call(device, `<GetCapabilities xmlns="${NS.device}"><Category>All</Category></GetCapabilities>`);
    const xaddr = (name: string) => {
      const url = textOf(child(find(body, 'Capabilities'), name), 'XAddr');
      return url ? atHost(url) : undefined;
    };
    const media = xaddr('Media');
    const events = xaddr('Events');
    const ptz = xaddr('PTZ');
    return { ...(media ? { media } : {}), ...(events ? { events } : {}), ...(ptz ? { ptz } : {}) };
  };

  /** The camera's services, asked once for as long as they answer. */
  const servicesNow = (): Promise<OnvifServices> => {
    services ??= servicesOf().catch((error) => {
      services = undefined;
      throw error;
    });
    return services;
  };

  const service = async (name: keyof OnvifServices): Promise<string> => {
    const url = (await servicesNow())[name];
    if (!url) throw new Error(`the camera has no ${name} service`);
    return url;
  };

  const uriOf = (body: XmlElement): string => {
    const uri = textOf(find(body, 'MediaUri'), 'Uri');
    if (!uri) throw new Error('the camera named no address');
    return uri;
  };

  const ptzBody = (operation: string, profile: string, rest = '') =>
    `<${operation} xmlns="${NS.ptz}"><ProfileToken>${escapeXml(profile)}</ProfileToken>${rest}</${operation}>`;

  return {
    device,
    services: servicesNow,

    info: async (): Promise<OnvifInfo> => {
      const body = await call(device, `<GetDeviceInformation xmlns="${NS.device}"/>`);
      const manufacturer = textOf(body, 'Manufacturer');
      const model = textOf(body, 'Model');
      const firmware = textOf(body, 'FirmwareVersion');
      const serial = textOf(body, 'SerialNumber');
      return { ...(manufacturer ? { manufacturer } : {}), ...(model ? { model } : {}), ...(firmware ? { firmware } : {}), ...(serial ? { serial } : {}) };
    },

    profiles: async (): Promise<OnvifProfile[]> => readProfiles(await call(await service('media'), `<GetProfiles xmlns="${NS.media}"/>`)),

    /** The profile's RTSP address, without credentials. */
    streamUri: async (profile: string): Promise<string> =>
      atHost(uriOf(
        await call(
          await service('media'),
          `<GetStreamUri xmlns="${NS.media}"><StreamSetup><Stream xmlns="${NS.schema}">RTP-Unicast</Stream>` +
            `<Transport xmlns="${NS.schema}"><Protocol>RTSP</Protocol></Transport></StreamSetup><ProfileToken>${escapeXml(profile)}</ProfileToken></GetStreamUri>`,
        ),
      )),

    snapshotUri: async (profile: string): Promise<string> =>
      atHost(uriOf(await call(await service('media'), `<GetSnapshotUri xmlns="${NS.media}"><ProfileToken>${escapeXml(profile)}</ProfileToken></GetSnapshotUri>`))),

    topics: async (): Promise<string[]> => readTopics(await call(await service('events'), `<GetEventProperties xmlns="${NS.events}"/>`)),

    /** A PullPoint for the camera's events, ended by the camera unless renewed within `seconds`. */
    subscribe: async (seconds: number): Promise<OnvifSubscription> => {
      const body = await call(
        await service('events'),
        `<CreatePullPointSubscription xmlns="${NS.events}"><InitialTerminationTime>PT${seconds}S</InitialTerminationTime></CreatePullPointSubscription>`,
        { action: `${NS.events}/EventPortType/CreatePullPointSubscriptionRequest` },
      );
      const reference = find(body, 'SubscriptionReference');
      const address = textOf(reference, 'Address');
      if (!address) throw new Error('the camera made no PullPoint');
      return { address: atHost(address), parameters: (child(reference, 'ReferenceParameters')?.children ?? []).map(writeXml).join('') };
    },

    /** What the PullPoint has, waiting up to `seconds` for something to come, or until `signal` aborts. */
    pull: async (subscription: OnvifSubscription, seconds: number, signal?: AbortSignal): Promise<OnvifMessage[]> =>
      readMessages(
        await call(
          subscription.address,
          `<PullMessages xmlns="${NS.events}"><Timeout>PT${seconds}S</Timeout><MessageLimit>64</MessageLimit></PullMessages>`,
          {
            action: `${NS.events}/PullPointSubscription/PullMessagesRequest`,
            to: subscription.address,
            parameters: subscription.parameters,
            timeoutMs: (seconds + 10) * 1000,
            signal,
          },
        ),
      ),

    renew: async (subscription: OnvifSubscription, seconds: number): Promise<void> =>
      void await call(subscription.address, `<Renew xmlns="${NS.wsnt}"><TerminationTime>PT${seconds}S</TerminationTime></Renew>`, {
        action: 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/RenewRequest',
        to: subscription.address,
        parameters: subscription.parameters,
      }),

    unsubscribe: async (subscription: OnvifSubscription): Promise<void> =>
      void await call(subscription.address, `<Unsubscribe xmlns="${NS.wsnt}"/>`, {
        action: 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/UnsubscribeRequest',
        to: subscription.address,
        parameters: subscription.parameters,
      }),

    /** The profile's presets: each one's token and name. */
    presets: async (profile: string): Promise<{ token: string; name: string }[]> =>
      findAll(await call(await service('ptz'), ptzBody('GetPresets', profile)), 'Preset').flatMap((preset) => {
        const token = preset.attrs.token;
        return token ? [{ token, name: textOf(preset, 'Name') ?? token }] : [];
      }),

    gotoPreset: async (profile: string, preset: string): Promise<void> =>
      void await call(await service('ptz'), ptzBody('GotoPreset', profile, `<PresetToken>${escapeXml(preset)}</PresetToken>`)),

    /** Starts turning at a speed from -1 to 1 for pan, tilt and zoom, until `stop`. */
    move: async (profile: string, speed: { pan?: number; tilt?: number; zoom?: number }): Promise<void> => {
      const panTilt = speed.pan || speed.tilt ? `<PanTilt xmlns="${NS.schema}" x="${speed.pan ?? 0}" y="${speed.tilt ?? 0}"/>` : '';
      const zoom = speed.zoom ? `<Zoom xmlns="${NS.schema}" x="${speed.zoom}"/>` : '';
      await call(await service('ptz'), ptzBody('ContinuousMove', profile, `<Velocity>${panTilt}${zoom}</Velocity>`));
    },

    stop: async (profile: string): Promise<void> => void await call(await service('ptz'), ptzBody('Stop', profile, '<PanTilt>true</PanTilt><Zoom>true</Zoom>')),
  };
};
