/**
 * The automation engine service: every automation that is on and has nothing wrong with it, each
 * fed from a durable queue bound to every device's readings, presses and coming and going (`dev.#`)
 * and by a clock, and read again when its file changes.
 *
 * Each runs with its owner's rights: it hears only the endpoints its owner may read, is primed
 * with the latest readings as its owner reads them, writes controls through the VFS as its owner,
 * and runs shell lines through `runas` as its owner. Those rights are checked when it is read and
 * every minute after; one that lost them is held back, saying why.
 *
 * A file whose change does not change how it runs (a node moved, a label) keeps its engine and
 * timers. A changed one starts afresh, primed, and takes over the deadlines its nodes waited for;
 * so does every one when the service starts, from the deadlines kept in its state file.
 *
 * A message said more than a minute before the service started (it waited in the queue while the
 * service was down) or replayed from the broker moves state but acts on nothing: a press from an
 * hour ago does not switch a lamp now. A reading's own time is not judged otherwise: a throttled
 * one is published with the time it came, which may be minutes before.
 */

import type { DeviceMessage } from '@ein/api';
import { type Access, accessOfUser, ADMIN_ACCESS, type Command, type ResourceHandleIf, shq } from '@ein/client';
import type { AutomationProblem, AutomationValue } from './api.ts';
import { accounts, type AutomationFile, endpointState, localTime, onlineOf, readAutomationFiles, readText, runLogPath, statePath, writeText } from './automation-files.ts';
import { type Action, AutomationEngine, type Deadline, type DeviceEvent, type LogEntry, type Message, readsOf } from './automations/engine.ts';
import { fingerprint } from './automations/graph.ts';
import { valueOfText } from './automations/values.ts';
import { AUTOMATIONS_DIR, AUTOMATIONS_KEYS, AUTOMATIONS_QUEUE, MODULE_AUTOMATIONS_DIR, MODULE_RUN_LOGS_DIR, MODULE_STATE_DIR, RUN_LOGS_DIR, STATE_DIR } from './paths.ts';
import { setEngineState } from './state.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const TICK_MS = 10_000;
const RELOAD_DELAY_MS = 1000;
/** How often the owners' rights are checked again. */
const RECHECK_MS = 60_000;
/** How often deadlines that changed are written to the state files. */
const SAVE_MS = 5000;
/** A message said this long before the service started moves state but acts on nothing; a deadline this late is dropped. */
const STALE_MS = 60_000;
/** The most of a shell line's output kept as the value it sends on. */
const OUTPUT_MAX = 4096;

type ServiceOptions = {
  cmd: Command;
  stopped: Promise<void>;
  /** The group whose members write automations, which owns their folder. */
  automationGid?: number;
};

type Run = {
  file: AutomationFile;
  engine: AutomationEngine;
  owner: string;
  access: Access;
  /** What decides how it runs: its graph without positions, its owner, its rights. */
  key: string;
  /** The endpoints and devices whose messages it is given. */
  hears: Set<string>;
  /** The deadlines last written to its state file. */
  saved: string;
};

const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
const leaf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** A device's message as an automation hears it, with when it was said, in ms. A track's fix is none of an automation's. */
const eventOf = (data: unknown): (DeviceEvent & { retained?: boolean }) | undefined => {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Partial<DeviceMessage>;
  if (typeof record.device !== 'string') return undefined;
  const at = Date.parse(record.at ?? '') || Date.now();
  const retained = record.retained ? { retained: true } : {};
  if (record.endpoint === undefined) return typeof record.online === 'boolean' ? { device: record.device, online: record.online, at, ...retained } : undefined;
  if (typeof record.endpoint !== 'string' || record.value === undefined) return undefined;
  return { device: record.device, endpoint: record.endpoint, value: record.value, ...(record.event ? { event: true } : {}), at, ...retained };
};

export const runAutomationService = async ({ cmd, stopped, automationGid }: ServiceOptions): Promise<void> => {
  const { vfs } = cmd.sys;
  const log = (line: string) => cmd.writeLn(`automation-engine: ${line}`).catch(() => {});
  const group = automationGid === undefined ? {} : { gid: automationGid };
  let stopping = false;
  stopped.then(() => stopping = true);

  await vfs.ensure(cmd.access, 'directory', parent(AUTOMATIONS_DIR), leaf(AUTOMATIONS_DIR), { props: { mode: 0o770, ...group } });
  await vfs.ensure(cmd.access, 'directory', parent(MODULE_AUTOMATIONS_DIR), leaf(MODULE_AUTOMATIONS_DIR), { props: { mode: 0o755 } });
  for (const dir of [RUN_LOGS_DIR, MODULE_RUN_LOGS_DIR]) await vfs.ensure(cmd.access, 'directory', parent(dir), leaf(dir), { props: { mode: 0o755 } });
  for (const dir of [STATE_DIR, MODULE_STATE_DIR]) await vfs.ensure(cmd.access, 'directory', parent(dir), leaf(dir), { props: { mode: 0o700 } });
  await vfs.ensure(cmd.access, 'queue', parent(AUTOMATIONS_QUEUE), leaf(AUTOMATIONS_QUEUE), { attrs: { routingKeys: AUTOMATIONS_KEYS } });
  await vfs.update(cmd.access, AUTOMATIONS_QUEUE, { attrs: { routingKeys: AUTOMATIONS_KEYS } });

  const users = accounts(vfs);
  const runs = new Map<string, Run>();
  /** Every automation read, with why it does not run. */
  let known = new Map<string, AutomationProblem[]>();
  const state = {
    actions: 0,
    known: () => new Map([...known].map(([name, problems]) => [name, { running: runs.has(name), problems }])),
    status: (name: string) => runs.get(name)?.engine.status(),
    press: (name: string, node: string) => {
      const run = runs.get(name);
      if (!run) throw new Error(`${name} is not running`);
      run.engine.press(node);
    },
    reload: () => load(true),
  };

  /** Append to an automation's run log, its owner's alone to read. */
  const runLog = async (run: Run, entry: LogEntry) => {
    const path = runLogPath(run.file.name);
    try {
      if (!(await vfs.exists(ADMIN_ACCESS, path))) {
        if (run.file.module) await vfs.ensure(ADMIN_ACCESS, 'directory', MODULE_RUN_LOGS_DIR, run.file.module, { props: { mode: 0o755 } });
        await vfs.ensure(ADMIN_ACCESS, 'log', parent(path), leaf(path), { props: { uid: run.file.owner, mode: 0o600 }, attrs: { retention: '30 day' } });
      }
      const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'a' });
      try {
        await handle.write(encoder.encode(JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n'));
      } finally {
        await handle.close();
      }
    } catch (error) {
      await log(`${run.file.name}: its run log: ${error}`);
    }
  };

  const act = async (run: Run, action: Action) => {
    state.actions++;
    if (action.kind === 'control') {
      const handle = await vfs.open(run.access, `/dev/${action.endpoint}`, { mode: 'w' });
      try {
        await handle.write(encoder.encode(`${action.value}\n`));
      } finally {
        await handle.close();
      }
      return;
    }
    const line = `export ${Object.entries(action.env).map(([name, value]) => `${name}=${shq(value)}`).join(' ')}; ${action.line}`;
    const result = await cmd.execute(`runas ${run.file.owner} ${shq(line)}`, { timeoutMs: action.timeoutMs });
    if (result.timedOut) throw new Error(`${action.line}: still running after ${action.timeoutMs / 1000} s, so stopped`);
    if (result.code !== 0) throw new Error(`${action.line} failed (${result.code})${result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 300)}` : ''}`);
    return valueOfText(result.stdout.slice(0, OUTPUT_MAX));
  };

  /** The run's rights over what it reads and writes, or why it may not run. */
  const rights = async (file: AutomationFile, access: Access): Promise<AutomationProblem[]> => {
    const { endpoints, controls, devices } = readsOf(file.automation!);
    const problems: AutomationProblem[] = [];
    for (const endpoint of endpoints) {
      if (!(await endpointState(vfs, access, endpoint)).readable) problems.push({ message: `its owner may not read ${endpoint}, or there is no such endpoint` });
    }
    for (const endpoint of controls) {
      if (!(await endpointState(vfs, access, endpoint)).writable) problems.push({ message: `its owner may not write ${endpoint}, or there is no such control` });
    }
    for (const device of devices) {
      if (!(await vfs.get(access, `/dev/${device}`).catch(() => undefined))) problems.push({ message: `its owner may not see the device ${device}, or there is none` });
    }
    return problems;
  };

  const readDeadlines = async (name: string): Promise<Deadline[]> => {
    try {
      const deadlines = JSON.parse(await readText(vfs, ADMIN_ACCESS, statePath(name)));
      return Array.isArray(deadlines) ? deadlines : [];
    } catch {
      return [];
    }
  };

  const saveDeadlines = async (run: Run) => {
    const text = JSON.stringify(run.engine.pending());
    if (text === run.saved) return;
    run.saved = text;
    const path = statePath(run.file.name);
    if (run.file.module) await vfs.ensure(ADMIN_ACCESS, 'directory', MODULE_STATE_DIR, run.file.module, { props: { mode: 0o700 } });
    await writeText(vfs, ADMIN_ACCESS, path, text, 0o600);
  };

  /** Stop an automation; `forget` its deadlines too when it stops for good, not for a restart. */
  const stopRun = async (name: string, forget = false) => {
    const run = runs.get(name);
    run?.engine.stop();
    runs.delete(name);
    if (run && forget) await vfs.unlink(ADMIN_ACCESS, statePath(name), parent(statePath(name))).catch(() => {});
  };

  /** Start an automation: primed as its owner, with the deadlines it waited for. */
  const start = async (file: AutomationFile, owner: string, access: Access, key: string, deadlines: Deadline[]): Promise<Run> => {
    const run = { file, owner, access, key, hears: new Set<string>(), saved: '' } as Run;
    run.engine = new AutomationEngine(file.name, file.automation!, {
      schedule: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
      now: Date.now,
      localTime,
      act: (_node, action) => act(run, action),
      link: (name: string, message: Message) => {
        for (const other of runs.values()) if (other.file.owner === run.file.owner) other.engine.link(name, message);
      },
      log: (entry) => void runLog(run, entry),
    });
    const { endpoints, controls, devices } = run.engine.reads();
    run.hears = new Set([...endpoints, ...controls, ...devices]);
    const values = new Map<string, { value: AutomationValue; at: number }>();
    for (const endpoint of new Set([...endpoints, ...controls])) {
      const seed = await endpointState(vfs, access, endpoint);
      if (seed.value !== undefined && seed.at !== undefined) values.set(endpoint, { value: seed.value, at: seed.at });
    }
    run.engine.prime({ values, online: await onlineOf(vfs, access, devices) });
    run.engine.restore(deadlines, STALE_MS);
    run.saved = JSON.stringify(deadlines);
    return run;
  };

  /**
   * Read the automations and bring the engines in line: start what is new or changed, stop what is
   * gone, off or wrong. With `recheck`, the owners' rights of the unchanged ones are checked again.
   */
  const load = async (recheck = false) => {
    if (recheck) users.forget();
    const files = await readAutomationFiles(vfs, ADMIN_ACCESS);
    const next = new Map<string, AutomationProblem[]>();
    for (const file of files) {
      const problems = [...file.problems];
      const was = runs.get(file.name);
      if (!file.enabled || problems.length || !file.automation) {
        await stopRun(file.name, true);
        next.set(file.name, problems);
        continue;
      }
      const key = `${file.owner}:${fingerprint(file.spec!)}`;
      if (was && was.key === key && !recheck) {
        was.file = file;
        next.set(file.name, []);
        continue;
      }
      try {
        const owner = file.module ? 'admin' : await users.nameOf(file.owner);
        const access = file.owner === ADMIN_ACCESS.uid ? ADMIN_ACCESS : await accessOfUser(vfs, ADMIN_ACCESS, owner);
        const denied = await rights(file, access);
        if (denied.length) {
          await stopRun(file.name, true);
          next.set(file.name, denied);
          continue;
        }
        if (was && was.key === key) {
          was.file = file;
          was.access = access;
          next.set(file.name, []);
          continue;
        }
        // A changed automation takes over what its nodes of the same kind waited for.
        const deadlines = was
          ? was.engine.pending().filter((deadline) => file.automation!.nodes.get(deadline.node)?.type === was.file.automation?.nodes.get(deadline.node)?.type)
          : await readDeadlines(file.name);
        await stopRun(file.name);
        runs.set(file.name, await start(file, owner, access, key, deadlines));
        next.set(file.name, []);
        await log(`${file.name}: ${was ? 'changed, started again' : 'started'}, as ${owner}`);
      } catch (error) {
        await stopRun(file.name, true);
        next.set(file.name, [{ message: error instanceof Error ? error.message : String(error) }]);
      }
    }
    for (const name of [...runs.keys()]) {
      if (!next.has(name)) {
        await stopRun(name, true);
        await log(`${name}: gone, stopped`);
      }
    }
    const held = [...next].filter(([, problems]) => problems.length);
    if (held.length && !recheck) await log(`not run: ${held.map(([name, problems]) => `${name}: ${problems[0].message}`).join('; ')}`);
    known = next;
  };

  let reload: ReturnType<typeof setTimeout> | undefined;
  const watch = (dir: string) =>
    vfs.subscribe?.(() => cmd.access, () => {
      clearTimeout(reload);
      reload = setTimeout(() => load().catch((error) => log(`reading the automations: ${error}`)), RELOAD_DELAY_MS);
    }, { pathPrefix: dir });
  const subscriptions = [await watch(AUTOMATIONS_DIR), await watch(MODULE_AUTOMATIONS_DIR)];

  const startedAt = Date.now();
  await load();
  setEngineState(state);
  const now = Date.now();
  for (const run of runs.values()) run.engine.tick(now);
  const clock = setInterval(() => {
    const at = Date.now();
    for (const run of runs.values()) run.engine.tick(at);
  }, TICK_MS);
  const recheck = setInterval(() => load(true).catch((error) => log(`checking the automations again: ${error}`)), RECHECK_MS);
  const save = setInterval(() => {
    for (const run of runs.values()) saveDeadlines(run).catch((error) => log(`${run.file.name}: keeping its deadlines: ${error}`));
  }, SAVE_MS);

  const abort = new AbortController();
  stopped.then(() => abort.abort());
  let queue: ResourceHandleIf | undefined;
  try {
    queue = await vfs.open(cmd.access, AUTOMATIONS_QUEUE, { mode: 'r+' });
    while (!stopping) {
      const bytes = await queue.read(1, abort.signal);
      if (bytes.length === 0) continue;
      try {
        const event = eventOf(JSON.parse(decoder.decode(bytes)));
        if (event) {
          const key = event.endpoint === undefined ? event.device : `${event.device}/${event.endpoint}`;
          const quiet = event.retained === true || event.at < startedAt - STALE_MS;
          for (const run of runs.values()) if (run.hears.has(key)) run.engine.handle(event, { quiet });
        }
      } catch (error) {
        await log(`a message it could not read: ${error}`);
      }
      await queue.write(encoder.encode('ack\n'));
    }
  } finally {
    clearInterval(clock);
    clearInterval(recheck);
    clearInterval(save);
    clearTimeout(reload);
    for (const run of runs.values()) await saveDeadlines(run).catch(() => {});
    for (const name of [...runs.keys()]) await stopRun(name);
    for (const subscription of subscriptions) await subscription?.unsubscribe().catch(() => {});
    await queue?.close().catch(() => {});
    setEngineState(undefined);
    await log('stopped');
  }
};
