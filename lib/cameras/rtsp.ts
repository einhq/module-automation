/**
 * The `rtsp` driver: a camera on the network that sends its picture over RTSP, made by a person with
 * its stream's address (`device-create 'Front door' --driver rtsp --config url=rtsp://… --config
 * password=…`): `url` its main stream, `sub` a second, smaller one, `snapshot` its still picture.
 * The password is the device's secret, put into the addresses only here. What a camera driver does
 * with its streams is `camera.ts`'s.
 */

import { ADMIN_ACCESS } from '@ein/client';
import { type CameraKind, type CameraOptions, withCredentials } from './camera.ts';

export const RTSP_DRIVER = 'rtsp';

/** A camera's streams: the config field each address is in, and the endpoint it becomes. */
const STREAMS = [
  { field: 'url', endpoint: 'main', label: 'Main stream' },
  { field: 'sub', endpoint: 'sub', label: 'Smaller stream' },
] as const;

export const rtspCamera = ({ devices }: CameraOptions): CameraKind => ({
  name: RTSP_DRIVER,
  description: 'A camera that sends its picture over RTSP: its streams, to watch live and take a picture of',
  config: [
    { name: 'url', label: 'Stream address, rtsp://camera/…', type: 'url', required: true },
    { name: 'sub', label: 'Address of a second, smaller stream', type: 'url' },
    { name: 'snapshot', label: 'Address of a still picture, http://camera/…', type: 'url' },
    { name: 'user', label: 'User', type: 'string' },
    { name: 'password', label: 'Password', type: 'string', secret: true },
  ],
  streams: async (device, attrs) => {
    const config = attrs.config ?? {};
    const secret = await devices.secret(ADMIN_ACCESS, device);
    return STREAMS.filter((stream) => config[stream.field]).map((stream) => ({
      endpoint: stream.endpoint,
      label: stream.label,
      address: withCredentials(config[stream.field], config.user, secret.password),
    }));
  },
  snapshot: async (device, attrs) => {
    const url = attrs.config?.snapshot;
    if (!url) return undefined;
    return { url, user: attrs.config?.user, password: (await devices.secret(ADMIN_ACCESS, device)).password };
  },
});
