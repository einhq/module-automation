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
  match(host: NetworkHost): { label?: string; model?: string; firmware?: string } | undefined;
  identity: Omit<NetworkIdentity, 'label' | 'model' | 'firmware'>;
};

const service = (host: NetworkHost, type: string): Mdns | undefined => host.mdns.find((each) => each.type === type);
const services = (host: NetworkHost, test: (each: Mdns) => boolean): Mdns | undefined => host.mdns.find(test);
const described = (host: NetworkHost, test: (each: Ssdp) => boolean): Ssdp | undefined => host.ssdp.find((each) => each.manufacturer !== undefined && test(each));
/** A host's name without `.local`. */
const stem = (name: string): string => name.replace(/\.local\.?$/, '');

const SHELLY_GEN1_CONNECT = 'Turns on MQTT in the Shelly, pointed at EiN’s broker, and restarts it. Shelly’s cloud is turned off while MQTT is on.';

const PATTERNS: Pattern[] = [
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
    identity: { kind: 'matter', vendor: 'Matter', addable: false, connect: 'Matter devices cannot be added yet.' },
  },
  {
    match: (host) => {
      const hap = service(host, '_hap._tcp');
      return hap && { label: hap.instance, model: hap.txt.md };
    },
    identity: { kind: 'homekit', vendor: 'HomeKit', addable: false, connect: 'HomeKit accessories cannot be added yet.' },
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
      addable: false,
      connect: 'The lights behind a Hue bridge cannot be added yet; Zigbee2MQTT with a stick of its own brings Zigbee lights.',
    },
  },
  {
    match: (host) => {
      const sonos = service(host, '_sonos._tcp');
      const upnp = described(host, (each) => /sonos/i.test(each.manufacturer ?? ''));
      return (sonos || upnp) && { label: upnp?.friendlyName ?? sonos?.instance, model: upnp?.modelName };
    },
    identity: { kind: 'sonos', vendor: 'Sonos', class: 'speaker', addable: false },
  },
  {
    match: (host) => {
      const cast = service(host, '_googlecast._tcp');
      return cast && { label: cast.txt.fn || cast.instance, model: cast.txt.md };
    },
    identity: { kind: 'cast', vendor: 'Google Cast', class: 'media', addable: false },
  },
  {
    match: (host) => {
      const airplay = services(host, (each) => each.type === '_airplay._tcp' || each.type === '_raop._tcp');
      return airplay && { label: airplay.instance.replace(/^[0-9A-F]{12}@/, ''), model: airplay.txt.model ?? airplay.txt.am };
    },
    identity: { kind: 'airplay', vendor: 'AirPlay', class: 'media', addable: false },
  },
  {
    match: (host) => {
      const printer = services(host, (each) => ['_ipp._tcp', '_ipps._tcp', '_printer._tcp', '_pdl-datastream._tcp'].includes(each.type));
      return printer && { label: printer.instance, model: printer.txt.ty ?? printer.txt.product?.replace(/^\(|\)$/g, '') };
    },
    identity: { kind: 'printer', class: 'printer', addable: false },
  },
  {
    match: (host) => {
      const router = described(host, (each) => /InternetGatewayDevice/.test(each.deviceType ?? ''));
      return router && { label: router.friendlyName, model: router.modelName };
    },
    identity: { kind: 'router', class: 'router', addable: false },
  },
  {
    match: (host) => {
      const renderer = described(host, (each) => /MediaRenderer/.test(each.deviceType ?? ''));
      return renderer && { label: renderer.friendlyName, model: renderer.modelName };
    },
    identity: { kind: 'media', class: 'media', addable: false },
  },
  {
    match: (host) => {
      const nas = services(host, (each) => ['_smb._tcp', '_afpovertcp._tcp', '_adisk._tcp', '_nfs._tcp'].includes(each.type)) ??
        described(host, (each) => /synology|qnap/i.test(each.manufacturer ?? ''));
      return nas && { label: 'instance' in nas ? nas.instance : nas.friendlyName, model: 'modelName' in nas ? nas.modelName : undefined };
    },
    identity: { kind: 'storage', class: 'storage', addable: false },
  },
];

/** What is known of a host without a pattern: its UPnP description, else its first service. */
const fallback = (host: NetworkHost): NetworkIdentity => {
  const upnp = described(host, () => true);
  return {
    kind: 'other',
    addable: false,
    ...(upnp?.manufacturer ? { vendor: upnp.manufacturer } : {}),
    label: upnp?.friendlyName ?? host.mdns[0]?.instance ?? (host.names[0] ? stem(host.names[0]) : host.ip),
    ...(upnp?.modelName ? { model: upnp.modelName } : {}),
  };
};

/** What `host` is. */
export const identify = (host: NetworkHost): NetworkIdentity => {
  for (const pattern of PATTERNS) {
    const found = pattern.match(host);
    if (!found) continue;
    const label = found.label || (host.names[0] ? stem(host.names[0]) : host.ip);
    return {
      ...pattern.identity,
      label,
      ...(found.model ? { model: found.model } : {}),
      ...(found.firmware ? { firmware: found.firmware } : {}),
    };
  }
  return fallback(host);
};

/**
 * The names under /dev the host could have as a device: its mDNS host names and instances, which
 * Shelly's and ESPHome's MQTT names are made from.
 */
export const namesOf = (host: NetworkHost): string[] => [...new Set([...host.names.map(stem), ...host.mdns.map((each) => each.instance)])];
