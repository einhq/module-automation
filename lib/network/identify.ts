/**
 * What a host on the network is, from what it answered the network listener: its mDNS services
 * (type, instance name, TXT records), its SSDP answers and UPnP description, and its hardware
 * address. Patterns are tried in order and the first that matches names it, as Home Assistant's
 * integrations each declare theirs; a host no pattern knows is named from whatever it said.
 */

import type { NetworkHost, NetworkIdentity } from '../api.ts';

type Mdns = NetworkHost['mdns'][number];
type Ssdp = NetworkHost['ssdp'][number];

type Pattern = {
  /** Matches the host, and says what of it is the label and model when it does. */
  match(host: NetworkHost): { label?: string; model?: string; firmware?: string; serial?: string; vendor?: string } | undefined;
  identity: Omit<NetworkIdentity, 'label' | 'model' | 'firmware' | 'serial'>;
};

const service = (host: NetworkHost, type: string): Mdns | undefined => host.mdns.find((each) => each.type === type);
const services = (host: NetworkHost, test: (each: Mdns) => boolean): Mdns | undefined => host.mdns.find(test);
const described = (host: NetworkHost, test: (each: Ssdp) => boolean): Ssdp | undefined => host.ssdp.find((each) => each.manufacturer !== undefined && test(each));
/** A host's name without `.local`. */
const stem = (name: string): string => name.replace(/\.local\.?$/, '');

/** What becomes a device over MQTT, and so is not added as a bare host. */
const MQTT_ONLY = new Set(['esphome', 'tasmota']);

const SHELLY_GEN1_CONNECT = 'Turns on MQTT in the Shelly, pointed at EiN’s broker, and restarts it. Shelly’s cloud is turned off while MQTT is on.';

/** The values of an ONVIF camera's scopes of one kind (`name`, `hardware`), decoded. */
const scopes = (host: NetworkHost, kind: string): string[] =>
  host.wsd.flatMap((each) => each.scopes).flatMap((scope) => {
    const value = scope.match(new RegExp(`^onvif://www\\.onvif\\.org/${kind}/(.+)$`, 'i'))?.[1];
    if (!value) return [];
    try {
      return [decodeURIComponent(value).replace(/_/g, ' ')];
    } catch {
      return [value];
    }
  });

const PATTERNS: Pattern[] = [
  {
    // First: a camera announces a web page and more besides, which other patterns would take.
    match: (host) => {
      if (!host.wsd.some((each) => each.types.some((type) => /NetworkVideoTransmitter/.test(type)) || each.scopes.some((scope) => /^onvif:/i.test(scope)))) return undefined;
      const [name] = scopes(host, 'name');
      return { label: name ?? (host.names[0] ? stem(host.names[0]) : undefined), model: scopes(host, 'hardware')[0] };
    },
    identity: {
      kind: 'camera',
      class: 'camera',
      addable: true,
      adopt: 'onvif',
      connect: 'Added with its user and password, it gives its streams to watch live, its motion and people seen, and its presets and moves where it turns.',
    },
  },
  {
    // Gen2 and later announce `_shelly._tcp` with gen, app (the model) and ver.
    match: (host) => {
      const shelly = service(host, '_shelly._tcp');
      return shelly && { label: shelly.instance, model: shelly.txt.app, firmware: shelly.txt.ver };
    },
    identity: { kind: 'shelly', vendor: 'Shelly', addable: true, adopt: 'shelly', connect: 'Points the Shelly’s MQTT at EiN’s broker and restarts it.' },
  },
  {
    // The first generation has only an HTTP service, named after its model and id.
    match: (host) => {
      const http = services(host, (each) => each.type === '_http._tcp' && /^shelly/i.test(each.instance) && (each.txt.gen ?? '1') === '1');
      return http && { label: http.instance, model: http.instance.replace(/-[0-9a-f]{6,12}$/i, '') };
    },
    identity: { kind: 'shelly-gen1', vendor: 'Shelly', addable: true, adopt: 'shelly-gen1', connect: SHELLY_GEN1_CONNECT },
  },
  {
    match: (host) => {
      const esphome = service(host, '_esphomelib._tcp');
      return esphome && { label: esphome.txt.friendly_name || esphome.instance, model: esphome.txt.board || esphome.txt.platform, firmware: esphome.txt.version };
    },
    identity: {
      kind: 'esphome',
      vendor: 'ESPHome',
      addable: true,
      connect: 'Give its YAML an mqtt: section with EiN’s broker and flash it; it then announces itself and becomes a device.',
    },
  },
  {
    match: (host) => {
      const tasmota = services(host, (each) => /tasmota/i.test(each.instance)) ?? (host.names.some((name) => /^tasmota/i.test(name)) ? host.mdns[0] : undefined);
      return tasmota && { label: tasmota.instance };
    },
    identity: {
      kind: 'tasmota',
      vendor: 'Tasmota',
      addable: true,
      connect: 'Set its MQTT host, user and password to EiN’s broker (Configuration → MQTT) and run SetOption19 1, so it announces itself.',
    },
  },
  {
    match: (host) => {
      const matter = services(host, (each) => each.type === '_matter._tcp' || each.type === '_matterc._udp');
      return matter && { label: matter.txt.DN || matter.instance };
    },
    identity: { kind: 'matter', vendor: 'Matter', addable: true, connect: 'Added, it says whether it answers; Matter itself is not spoken yet.' },
  },
  {
    match: (host) => {
      const hap = service(host, '_hap._tcp');
      return hap && { label: hap.instance, model: hap.txt.md };
    },
    identity: { kind: 'homekit', vendor: 'HomeKit', addable: true, connect: 'Added, it says whether it answers; HomeKit itself is not spoken yet.' },
  },
  {
    match: (host) => {
      const hue = service(host, '_hue._tcp') ?? services(host, (each) => /philips hue/i.test(each.instance));
      return hue && { label: hue.instance, model: hue.txt.modelid };
    },
    identity: {
      kind: 'hue',
      vendor: 'Philips Hue',
      class: 'hub',
      addable: true,
      connect: 'Added, it says whether it answers; the lights behind it are not read yet, and Zigbee2MQTT with a stick of its own brings Zigbee lights.',
    },
  },
  {
    match: (host) => {
      const sonos = service(host, '_sonos._tcp');
      const upnp = described(host, (each) => /sonos/i.test(each.manufacturer ?? ''));
      return (sonos || upnp) && { label: upnp?.friendlyName ?? sonos?.instance, model: upnp?.modelName };
    },
    identity: { kind: 'sonos', vendor: 'Sonos', class: 'speaker', addable: true },
  },
  {
    match: (host) => {
      const cast = service(host, '_googlecast._tcp');
      return cast && { label: cast.txt.fn || cast.instance, model: cast.txt.md };
    },
    identity: {
      kind: 'cast',
      vendor: 'Google Cast',
      class: 'speaker',
      addable: true,
      adopt: 'cast',
      connect: 'Added, it says what it plays, and its volume, mute, play, pause and stop can be set.',
    },
  },
  {
    match: (host) => {
      const airplay = services(host, (each) => each.type === '_airplay._tcp' || each.type === '_raop._tcp');
      return airplay && { label: airplay.instance.replace(/^[0-9A-F]{12}@/, ''), model: airplay.txt.model ?? airplay.txt.am };
    },
    identity: { kind: 'airplay', vendor: 'AirPlay', class: 'media', addable: true },
  },
  {
    match: (host) => {
      const printer = services(host, (each) => ['_ipp._tcp', '_ipps._tcp', '_printer._tcp', '_pdl-datastream._tcp'].includes(each.type));
      return printer && { label: printer.instance, model: printer.txt.ty ?? printer.txt.product?.replace(/^\(|\)$/g, '') };
    },
    identity: { kind: 'printer', class: 'printer', addable: true, adopt: 'ipp', connect: 'Added, it says its state, its warnings and how much ink or toner is left.' },
  },
  {
    match: (host) => {
      const router = described(host, (each) => /InternetGatewayDevice/.test(each.deviceType ?? ''));
      return router && { label: router.friendlyName, model: router.modelName };
    },
    identity: { kind: 'router', class: 'router', addable: true },
  },
  {
    match: (host) => {
      const renderer = described(host, (each) => /MediaRenderer/.test(each.deviceType ?? ''));
      return renderer && { label: renderer.friendlyName, model: renderer.modelName };
    },
    identity: { kind: 'media', class: 'media', addable: true },
  },
  {
    // NETGEAR's ReadyNAS says what it is in a record of its own, beside its file shares.
    match: (host) => {
      const readynas = service(host, '_readynas._tcp');
      return readynas && {
        label: host.names[0] ? stem(host.names[0]) : readynas.instance.replace(/^ReadyNAS Discovery \[(.*)\]$/, '$1'),
        vendor: readynas.txt.vendor,
        model: readynas.txt.model,
        serial: readynas.txt.serial,
      };
    },
    identity: { kind: 'storage', vendor: 'NETGEAR', class: 'storage', addable: true },
  },
  {
    // A file share is named after its host, not after the share (`zoidberg (CIFS)`).
    match: (host) => {
      const nas = services(host, (each) => ['_smb._tcp', '_afpovertcp._tcp', '_adisk._tcp', '_nfs._tcp'].includes(each.type)) ??
        described(host, (each) => /synology|qnap/i.test(each.manufacturer ?? ''));
      return nas && {
        label: host.names[0] ? stem(host.names[0]) : 'instance' in nas ? nas.instance : nas.friendlyName,
        model: 'modelName' in nas ? nas.modelName : undefined,
      };
    },
    identity: { kind: 'storage', class: 'storage', addable: true },
  },
];

/** What is known of a host without a pattern: its UPnP description, else its first service. */
const fallback = (host: NetworkHost): NetworkIdentity => {
  const upnp = described(host, () => true);
  return {
    kind: 'other',
    addable: true,
    adopt: 'network',
    connect: PRESENCE,
    ...(upnp?.manufacturer ? { vendor: upnp.manufacturer } : {}),
    label: upnp?.friendlyName ?? host.mdns[0]?.instance ?? (host.names[0] ? stem(host.names[0]) : host.ip),
    ...(upnp?.modelName ? { model: upnp.modelName } : {}),
  };
};

const PRESENCE = 'Added, it says whether it answers and how fast.';

/** What `host` is. Anything that can be added and has no driver of its own is added as `network`. */
export const identify = (host: NetworkHost): NetworkIdentity => {
  for (const pattern of PATTERNS) {
    const found = pattern.match(host);
    if (!found) continue;
    const label = found.label || (host.names[0] ? stem(host.names[0]) : host.ip);
    const presence = pattern.identity.addable && !pattern.identity.adopt && !MQTT_ONLY.has(pattern.identity.kind);
    return {
      ...pattern.identity,
      ...(found.vendor ? { vendor: found.vendor } : {}),
      ...(found.serial ? { serial: found.serial } : {}),
      ...(presence ? { adopt: 'network' as const, connect: pattern.identity.connect ?? PRESENCE } : {}),
      label,
      ...(found.model ? { model: found.model } : {}),
      ...(found.firmware ? { firmware: found.firmware } : {}),
    };
  }
  return fallback(host);
};

/** The page a web service names in its `path` record (DNS-SD's own key), else its root. */
const pathOf = (service: NetworkHost['mdns'][number]): string => /^\/[\w\-./~%]*$/.test(service.txt.path ?? '') ? service.txt.path : '/';

/**
 * The host's own web page at its address now, when it offers one: its HTTP service, or the admin
 * page a printer names. A `.local` name in a printer's is not used, as a browser may not resolve it.
 */
export const webPageOf = (host: NetworkHost): string | undefined => {
  const http = host.mdns.find((each) => each.type === '_http._tcp');
  if (http) return `http://${host.ip}${http.port && http.port !== 80 ? `:${http.port}` : ''}${pathOf(http)}`;
  const https = host.mdns.find((each) => each.type === '_https._tcp');
  if (https) return `https://${host.ip}${https.port && https.port !== 443 ? `:${https.port}` : ''}${pathOf(https)}`;
  const admin = host.mdns.map((each) => each.txt.adminurl).find((url) => url && /^https?:\/\//.test(url));
  return admin ? `${new URL(admin).protocol}//${host.ip}/` : undefined;
};

/**
 * The names under /dev the host could have as a device: its mDNS host names and instances, which
 * Shelly's and ESPHome's MQTT names are made from.
 */
export const namesOf = (host: NetworkHost): string[] => [...new Set([...host.names.map(stem), ...host.mdns.map((each) => each.instance)])];
