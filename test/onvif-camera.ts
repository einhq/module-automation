/**
 * A stub ONVIF camera: a device, media, events and PTZ service on one HTTP port, as far as the
 * `onvif` driver asks them. Every request but the clock must carry a UsernameToken whose digest
 * matches `password` and whose time is within a minute of the camera's clock, which runs
 * `clockOffsetMs` off ours. It has two profiles, a 2560×1440 H.265 main and a 640×360 H.264 sub,
 * pans, tilts and zooms on the main one, and has two presets. Events put in `events` are what its
 * PullPoint gives next; what was asked of its PTZ is in `ptz`.
 */

import { passwordDigest } from '../lib/cameras/onvif.ts';
import { find, parseXml, textOf } from '../lib/cameras/xml.ts';

export type StubEvent = { topic: string; name: string; value: string };

export const startOnvifCamera = (options: { user: string; password: string; streamHost?: string; clockOffsetMs?: number; hostname?: string; port?: number }) => {
  const events: StubEvent[] = [];
  const ptz: string[] = [];
  const asked: string[] = [];
  let subscriptions = 0;
  const offset = options.clockOffsetMs ?? 0;
  const stream = options.streamHost ?? '192.0.2.50';

  const envelope = (body: string) =>
    new Response(
      `<?xml version="1.0" encoding="UTF-8"?><env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema" ` +
        `xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" xmlns:wsa5="http://www.w3.org/2005/08/addressing" xmlns:tns1="http://www.onvif.org/ver10/topics" ` +
        `xmlns:wstop="http://docs.oasis-open.org/wsn/t-1"><env:Body>${body}</env:Body></env:Envelope>`,
      { headers: { 'content-type': 'application/soap+xml' } },
    );
  const fault = (code: string, status = 400) =>
    new Response(
      `<?xml version="1.0"?><env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope" xmlns:ter="http://www.onvif.org/ver10/error"><env:Body><env:Fault>` +
        `<env:Code><env:Value>env:Sender</env:Value><env:Subcode><env:Value>ter:${code}</env:Value></env:Subcode></env:Code>` +
        `<env:Reason><env:Text xml:lang="en">${code}</env:Text></env:Reason></env:Fault></env:Body></env:Envelope>`,
      { status, headers: { 'content-type': 'application/soap+xml' } },
    );

  const authorized = async (doc: ReturnType<typeof parseXml>): Promise<boolean> => {
    const token = find(doc, 'UsernameToken');
    const created = textOf(token, 'Created') ?? '';
    const nonce = Uint8Array.from(atob(textOf(token, 'Nonce') ?? ''), (char) => char.charCodeAt(0));
    if (textOf(token, 'Username') !== options.user) return false;
    if (Math.abs(Date.parse(created) - (Date.now() + offset)) > 60_000) return false;
    return textOf(token, 'Password') === await passwordDigest(nonce, created, options.password);
  };

  const server: Deno.HttpServer<Deno.NetAddr> = Deno.serve(
    { hostname: options.hostname ?? '127.0.0.1', port: options.port ?? 0, onListen: () => {} },
    async (req): Promise<Response> => {
      const base = `http://127.0.0.1:${server.addr.port}`;
      const doc = parseXml(await req.text());
      const body = find(doc, 'Body')!;
      const operation = body.children[0]?.name ?? '';
      asked.push(operation);
      if (operation === 'GetSystemDateAndTime') {
        const now = new Date(Date.now() + offset);
        return envelope(
          `<tds:GetSystemDateAndTimeResponse xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><tds:SystemDateAndTime><tt:UTCDateTime>` +
            `<tt:Time><tt:Hour>${now.getUTCHours()}</tt:Hour><tt:Minute>${now.getUTCMinutes()}</tt:Minute><tt:Second>${now.getUTCSeconds()}</tt:Second></tt:Time>` +
            `<tt:Date><tt:Year>${now.getUTCFullYear()}</tt:Year><tt:Month>${now.getUTCMonth() + 1}</tt:Month><tt:Day>${now.getUTCDate()}</tt:Day></tt:Date>` +
            `</tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`,
        );
      }
      if (!await authorized(doc)) return fault('NotAuthorized');
      switch (operation) {
        case 'GetDeviceInformation':
          return envelope(
            `<tds:GetDeviceInformationResponse xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><tds:Manufacturer>Acme</tds:Manufacturer>` +
              `<tds:Model>Dome 4</tds:Model><tds:FirmwareVersion>v2.1</tds:FirmwareVersion><tds:SerialNumber>AC0001</tds:SerialNumber></tds:GetDeviceInformationResponse>`,
          );
        case 'GetCapabilities':
          // The camera names itself at an address of its own; the driver asks it where it reached it.
          return envelope(
            `<tds:GetCapabilitiesResponse xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><tds:Capabilities>` +
              `<tt:Media><tt:XAddr>${base.replace('127.0.0.1', '10.9.9.9')}/onvif/media</tt:XAddr></tt:Media>` +
              `<tt:Events><tt:XAddr>${base}/onvif/events</tt:XAddr></tt:Events>` +
              `<tt:PTZ><tt:XAddr>${base}/onvif/ptz</tt:XAddr></tt:PTZ></tds:Capabilities></tds:GetCapabilitiesResponse>`,
          );
        case 'GetProfiles': {
          const profile = (token: string, encoding: string, width: number, height: number, ptz: boolean) =>
            `<trt:Profiles token="${token}" fixed="true"><tt:Name>${token}</tt:Name>` +
            `<tt:VideoEncoderConfiguration token="enc-${token}"><tt:Name>enc</tt:Name><tt:Encoding>${encoding}</tt:Encoding>` +
            `<tt:Resolution><tt:Width>${width}</tt:Width><tt:Height>${height}</tt:Height></tt:Resolution>` +
            `<tt:RateControl><tt:FrameRateLimit>25</tt:FrameRateLimit></tt:RateControl></tt:VideoEncoderConfiguration>` +
            (ptz
              ? `<tt:PTZConfiguration token="ptz"><tt:Name>ptz</tt:Name><tt:DefaultContinuousPanTiltVelocitySpace>x</tt:DefaultContinuousPanTiltVelocitySpace>` +
                `<tt:DefaultContinuousZoomVelocitySpace>x</tt:DefaultContinuousZoomVelocitySpace></tt:PTZConfiguration>`
              : '') +
            `</trt:Profiles>`;
          return envelope(
            `<trt:GetProfilesResponse xmlns:trt="http://www.onvif.org/ver10/media/wsdl">${profile('sub', 'H264', 640, 360, false)}${
              profile('main', 'H265', 2560, 1440, true)
            }<trt:Profiles token="audio"><tt:Name>audio</tt:Name></trt:Profiles></trt:GetProfilesResponse>`,
          );
        }
        case 'GetStreamUri':
        case 'GetSnapshotUri': {
          const token = textOf(body, 'ProfileToken');
          const uri = operation === 'GetStreamUri' ? `rtsp://${stream}:554/${token}` : `${base}/snapshot/${token}.jpg`;
          return envelope(
            `<trt:${operation}Response xmlns:trt="http://www.onvif.org/ver10/media/wsdl"><trt:MediaUri><tt:Uri>${uri}</tt:Uri></trt:MediaUri></trt:${operation}Response>`,
          );
        }
        case 'GetEventProperties':
          return envelope(
            `<tev:GetEventPropertiesResponse xmlns:tev="http://www.onvif.org/ver10/events/wsdl"><wstop:TopicSet>` +
              `<tns1:RuleEngine><CellMotionDetector><Motion wstop:topic="true"><tt:MessageDescription IsProperty="true"/></Motion></CellMotionDetector>` +
              `<PeopleDetector><People wstop:topic="true"/></PeopleDetector></tns1:RuleEngine></wstop:TopicSet></tev:GetEventPropertiesResponse>`,
          );
        case 'CreatePullPointSubscription':
          subscriptions++;
          return envelope(
            `<tev:CreatePullPointSubscriptionResponse xmlns:tev="http://www.onvif.org/ver10/events/wsdl"><tev:SubscriptionReference>` +
              `<wsa5:Address>${base}/onvif/pullpoint/${subscriptions}</wsa5:Address>` +
              `<wsa5:ReferenceParameters><dom0:SubscriptionId xmlns:dom0="http://example.com/event">${subscriptions}</dom0:SubscriptionId></wsa5:ReferenceParameters>` +
              `</tev:SubscriptionReference></tev:CreatePullPointSubscriptionResponse>`,
          );
        case 'PullMessages': {
          if (textOf(doc, 'SubscriptionId') !== String(subscriptions)) return fault('InvalidSubscription');
          for (let waited = 0; !events.length && waited < 1000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
          const messages = events.splice(0).map((event) =>
            `<wsnt:NotificationMessage><wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">${event.topic}</wsnt:Topic>` +
            `<wsnt:Message><tt:Message UtcTime="${new Date().toISOString()}" PropertyOperation="Changed"><tt:Source>` +
            `<tt:SimpleItem Name="VideoSourceConfigurationToken" Value="000"/></tt:Source>` +
            `<tt:Data><tt:SimpleItem Name="${event.name}" Value="${event.value}"/></tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>`
          ).join('');
          return envelope(`<tev:PullMessagesResponse xmlns:tev="http://www.onvif.org/ver10/events/wsdl">${messages}</tev:PullMessagesResponse>`);
        }
        case 'Renew':
        case 'Unsubscribe':
          return envelope(`<wsnt:${operation}Response/>`);
        case 'GetPresets':
          return envelope(
            `<tptz:GetPresetsResponse xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"><tptz:Preset token="1"><tt:Name>Gate</tt:Name></tptz:Preset>` +
              `<tptz:Preset token="2"><tt:Name>Driveway</tt:Name></tptz:Preset></tptz:GetPresetsResponse>`,
          );
        case 'GotoPreset':
          ptz.push(`goto ${textOf(body, 'PresetToken')}`);
          return envelope(`<tptz:GotoPresetResponse xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"/>`);
        case 'ContinuousMove': {
          const panTilt = find(body, 'PanTilt');
          const zoom = find(body, 'Zoom');
          ptz.push(`move ${panTilt ? `${panTilt.attrs.x},${panTilt.attrs.y}` : '-'} ${zoom?.attrs.x ?? '-'}`);
          return envelope(`<tptz:ContinuousMoveResponse xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"/>`);
        }
        case 'Stop':
          ptz.push('stop');
          return envelope(`<tptz:StopResponse xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"/>`);
        default:
          return fault('ActionNotSupported');
      }
    },
  );
  return { server, events, ptz, asked, address: () => `${options.hostname ?? '127.0.0.1'}:${server.addr.port}` };
};
