/**
 * The automation sidecar: the MQTT broker (Mosquitto), the network listener (discovery.ts) and the
 * restreamer (go2rtc) in one container on the host's network, for the Automation module's devices.
 * This supervisor writes what each of them reads, starts them, starts one again when it ends, and
 * prefixes each line of their output with its name.
 *
 * From the environment, with their defaults:
 *
 * - `EIN_BIND` (`0.0.0.0`): the address the broker, the restreamer's API and its RTSP server listen on.
 * - `MQTT_PORT` (1883); `MQTT_EIN_PASSWORD` and `MQTT_DEVICE_PASSWORD`, required: the broker's two
 *   accounts, `ein` and `device`. No anonymous client is let in. Its retained messages and the
 *   hashed passwords are kept in `/data/mqtt`.
 * - `STREAMS_PORT` (1984), the restreamer's HTTP API (sources, MSE over WebSocket, a JPEG frame);
 *   `RTSP_PORT` (8554), where it serves each source again over RTSP; `STREAMS_PASSWORD`, required:
 *   the API and RTSP's account `ein`. The API asks for it from this machine too; RTSP does not, as
 *   go2rtc lets loopback in.
 * - The listener's own settings (`DISCOVERY_INTERVAL`, `DISCOVERY_FORGET`, `DISCOVERY_PREFIX`),
 *   passed on to it.
 *
 * The restreamer's sources are EiN's to give: it adds them through the API when a camera is made,
 * and go2rtc keeps them in its config, which a restart of go2rtc alone reads again. A new container
 * starts with none, and EiN states them again when it finds them gone.
 *
 * Needs --allow-env, --allow-read, --allow-write (/data, /run/automation), --allow-run and --allow-net
 * (127.0.0.1, to wait for the broker).
 */

const env = (key: string, fallback = ''): string => Deno.env.get(key)?.trim() || fallback;
const port = (key: string, fallback: number): number => {
  const value = Number(env(key));
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : fallback;
};
const required = (key: string): string => {
  const value = env(key);
  if (!value) {
    console.error(`supervisor: ${key} is not set`);
    Deno.exit(1);
  }
  return value;
};

const BIND = env('EIN_BIND', '0.0.0.0');
const MQTT_PORT = port('MQTT_PORT', 1883);
const STREAMS_PORT = port('STREAMS_PORT', 1984);
const RTSP_PORT = port('RTSP_PORT', 8554);
const EIN_PASSWORD = required('MQTT_EIN_PASSWORD');
const DEVICE_PASSWORD = required('MQTT_DEVICE_PASSWORD');
const STREAMS_PASSWORD = required('STREAMS_PASSWORD');

const DATA = '/data/mqtt';
const RUN = '/run/automation';
/** An address to listen on in go2rtc's form: no host for every address. */
const listen = (portNumber: number): string => `${BIND === '0.0.0.0' ? '' : BIND}:${portNumber}`;
/** A YAML scalar: JSON's string is YAML's double-quoted one. */
const quoted = (text: string): string => JSON.stringify(text);

const log = (line: string) => console.log(`supervisor: ${line}`);

/** Mosquitto's config, and its password file hashed from the two accounts' passwords. */
const prepareBroker = async (): Promise<void> => {
  await Deno.mkdir(DATA, { recursive: true });
  await Deno.writeTextFile(
    `${RUN}/mosquitto.conf`,
    [
      BIND === '0.0.0.0' ? `listener ${MQTT_PORT}` : `listener ${MQTT_PORT} ${BIND}`,
      'allow_anonymous false',
      `password_file ${DATA}/passwords`,
      'persistence true',
      `persistence_location ${DATA}/`,
      'log_dest stdout',
      'user mosquitto',
      '',
    ].join('\n'),
  );
  await Deno.writeTextFile(`${DATA}/passwords`, `ein:${EIN_PASSWORD}\ndevice:${DEVICE_PASSWORD}\n`, { mode: 0o600 });
  await run('mosquitto_passwd', ['-U', `${DATA}/passwords`]);
  // What an earlier broker wrote may be another user's: the broker drops to its own.
  await run('chown', ['-R', 'mosquitto:mosquitto', DATA]);
};

/** go2rtc's config, which it also writes the sources EiN adds into while it runs. */
const prepareRestreamer = async (): Promise<void> => {
  await Deno.writeTextFile(
    `${RUN}/go2rtc.yaml`,
    [
      'api:',
      `  listen: ${quoted(listen(STREAMS_PORT))}`,
      '  username: ein',
      `  password: ${quoted(STREAMS_PASSWORD)}`,
      '  local_auth: true',
      'rtsp:',
      `  listen: ${quoted(listen(RTSP_PORT))}`,
      '  username: ein',
      `  password: ${quoted(STREAMS_PASSWORD)}`,
      // go2rtc opens WebRTC on 8555 unless told not to; pages watch over the API's WebSocket.
      'webrtc:',
      '  listen: ""',
      'log:',
      '  format: text',
      '  level: info',
      // No streams key: go2rtc adds it when the first source is added, and cannot add to `{}`.
      '',
    ].join('\n'),
  );
};

/** A command run to its end; throws when it fails. */
const run = async (command: string, args: string[]): Promise<void> => {
  const output = await new Deno.Command(command, { args, stdout: 'piped', stderr: 'piped' }).output();
  if (!output.success) {
    throw new Error(`${command} ${args.join(' ')}: ${new TextDecoder().decode(output.stderr).trim() || `exit ${output.code}`}`);
  }
};

/** Waits until the broker takes a connection, for at most `ms`. */
const waitForBroker = async (ms: number): Promise<void> => {
  const host = BIND === '0.0.0.0' ? '127.0.0.1' : BIND;
  for (const until = Date.now() + ms; Date.now() < until;) {
    try {
      (await Deno.connect({ hostname: host, port: MQTT_PORT })).close();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
};

type Child = { name: string; command: string; args: string[]; env?: Record<string, string>; process?: Deno.ChildProcess };

const children: Child[] = [
  { name: 'mqtt', command: 'mosquitto', args: ['-c', `${RUN}/mosquitto.conf`] },
  {
    name: 'discovery',
    command: 'deno',
    args: ['run', '--unstable-net', '--allow-net', '--allow-env', '--allow-run=cat', '--allow-sys=networkInterfaces', '/app/discovery.ts'],
    env: { MQTT_HOST: BIND, MQTT_PORT: String(MQTT_PORT), MQTT_USER: 'ein', MQTT_PASSWORD: EIN_PASSWORD },
  },
  { name: 'streams', command: 'go2rtc', args: ['-config', `${RUN}/go2rtc.yaml`] },
];

let stopping = false;

/** Each line of `stream` written out with `name: ` before it. */
const prefixed = async (name: string, stream: ReadableStream<Uint8Array>, out: { writeSync(bytes: Uint8Array): number }) => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let rest = '';
  for await (const bytes of stream) {
    const lines = (rest + decoder.decode(bytes, { stream: true })).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) out.writeSync(encoder.encode(`${name}: ${line}\n`));
  }
  if (rest) out.writeSync(encoder.encode(`${name}: ${rest}\n`));
};

/**
 * Runs `child`, and again each time it ends, after a pause that doubles from a second to half a
 * minute while it keeps ending within a minute of its start.
 */
const keep = async (child: Child): Promise<void> => {
  let pause = 1000;
  while (!stopping) {
    const started = Date.now();
    try {
      child.process = new Deno.Command(child.command, {
        args: child.args,
        env: child.env,
        stdin: 'null',
        stdout: 'piped',
        stderr: 'piped',
      }).spawn();
      const streams = Promise.all([prefixed(child.name, child.process.stdout, Deno.stdout), prefixed(child.name, child.process.stderr, Deno.stderr)]);
      const status = await child.process.status;
      await streams;
      if (stopping) return;
      log(`${child.name} ended (${status.signal ?? `exit ${status.code}`})`);
    } catch (error) {
      log(`${child.name} did not start: ${error instanceof Error ? error.message : String(error)}`);
    }
    pause = Date.now() - started > 60_000 ? 1000 : Math.min(pause * 2, 30_000);
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
};

/** Every child asked to end, and the supervisor ended once they have, or after ten seconds. */
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      child.process?.kill('SIGTERM');
    } catch { /* already ended */ }
  }
  const ended = Promise.all(children.map((child) => child.process?.status.catch(() => {})));
  Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 10_000))]).then(() => Deno.exit(0));
};

if (import.meta.main) {
  await Deno.mkdir(RUN, { recursive: true });
  await prepareBroker();
  await prepareRestreamer();
  Deno.addSignalListener('SIGTERM', stop);
  Deno.addSignalListener('SIGINT', stop);
  log(`broker on ${BIND}:${MQTT_PORT}, restreamer on ${BIND}:${STREAMS_PORT} (RTSP ${RTSP_PORT})`);
  const [broker, listener, restreamer] = children;
  const running = [keep(broker)];
  await waitForBroker(10_000);
  running.push(keep(listener), keep(restreamer));
  await Promise.all(running);
}
