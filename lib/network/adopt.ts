/**
 * A Shelly found on the network pointed at EiN's broker over its own HTTP API, then restarted, so
 * the `shelly` or `shelly-gen1` driver hears it as it comes back:
 *
 * - second generation and later: JSON-RPC `Mqtt.SetConfig` (status and RPC notifications on, as
 *   the `shelly` driver reads them), then `Shelly.Reboot`;
 * - first generation: `/settings?mqtt_enable=true&…`, then `/reboot`.
 *
 * A Shelly with a password of its own answers 401; it is not asked again with one.
 */

type Broker = { address: string; user?: string; password?: string };

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 8000;

const ask = async (fetcher: Fetch, url: string, init?: RequestInit): Promise<unknown> => {
  const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((error) => {
    throw new Error(`cannot reach ${new URL(url).host}: ${error instanceof Error ? error.message : error}`);
  });
  if (response.status === 401) {
    await response.body?.cancel();
    throw new Error('it has a password of its own: turn that off in its web page, or set its MQTT there');
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`it answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const rpc = async (fetcher: Fetch, ip: string, method: string, params?: Record<string, unknown>): Promise<unknown> => {
  const answer = await ask(fetcher, `http://${ip}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1, method, ...(params ? { params } : {}) }),
  }) as { error?: { message?: string }; result?: unknown };
  if (answer && typeof answer === 'object' && answer.error) throw new Error(`${method}: ${answer.error.message ?? 'refused'}`);
  return answer && typeof answer === 'object' && 'result' in answer ? answer.result : answer;
};

/** Points the Shelly at `ip` at the broker and restarts it. */
export const adoptShelly = async (fetcher: Fetch, ip: string, generation: 'shelly' | 'shelly-gen1', broker: Broker): Promise<void> => {
  if (generation === 'shelly') {
    await rpc(fetcher, ip, 'Mqtt.SetConfig', {
      config: {
        enable: true,
        server: broker.address,
        user: broker.user ?? null,
        pass: broker.password ?? null,
        rpc_ntf: true,
        status_ntf: true,
        enable_control: true,
      },
    });
    await rpc(fetcher, ip, 'Shelly.Reboot');
    return;
  }
  const query = new URLSearchParams({ mqtt_enable: 'true', mqtt_server: broker.address, mqtt_user: broker.user ?? '', mqtt_pass: broker.password ?? '' });
  await ask(fetcher, `http://${ip}/settings?${query}`);
  await ask(fetcher, `http://${ip}/reboot`);
};
