/**
 * The rules service: the engine fed from a durable queue bound to every reading, press and
 * online change on the bus, and by a clock, with the rules read again whenever their files change.
 * A rule's lines run one after another, through `runas` as the file's owner, until one fails; each
 * run is kept in the rules log. Runs never overlap: one waits for the one before.
 */

import { type Command, type ResourceHandleIf, shq } from '@ein/client';
import type { OnlineMessage, Reading } from './api.ts';
import { type Firing, RuleEngine } from './engine.ts';
import { RULES_DIR, RULES_KEYS, RULES_LOG, RULES_QUEUE } from './paths.ts';
import { latestValues, localTime, onlineDevices, readRuleFiles, type RuleFile } from './rule-files.ts';
import type { Message } from './rules.ts';
import { setRulesState } from './state.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const TICK_MS = 10_000;
const RELOAD_DELAY_MS = 1000;

/** One line of a run, as the rules log keeps it. */
type LineResult = { line: string; code: number; error?: string };

type ServiceOptions = {
  cmd: Command;
  stopped: Promise<void>;
  /** The group whose members write rules, which owns the rules folder and log. */
  automationGid?: number;
};

const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
const leaf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** A bus message as a rule sees it, or undefined when it is none of automation's. */
const messageOf = (data: unknown): Message | undefined => {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Partial<Reading & OnlineMessage>;
  if (typeof record.device !== 'string') return undefined;
  if (typeof record.online === 'boolean') return { kind: 'online', device: record.device, online: record.online };
  if (typeof record.entity !== 'string' || !('value' in record) || record.value === undefined) return undefined;
  if (record.kind === 'event') return { kind: 'event', device: record.device, entity: record.entity, value: String(record.value) };
  return { kind: 'state', device: record.device, entity: record.entity, value: record.value };
};

export const runRulesService = async ({ cmd, stopped, automationGid }: ServiceOptions): Promise<void> => {
  const { vfs } = cmd.sys;
  const log = (line: string) => cmd.writeLn(`automation-rules: ${line}`).catch(() => {});
  const group = automationGid === undefined ? {} : { gid: automationGid };
  let stopping = false;
  stopped.then(() => stopping = true);

  await vfs.ensure(cmd.access, 'directory', parent(parent(RULES_DIR)), leaf(parent(RULES_DIR)), { props: { mode: 0o755 } });
  await vfs.ensure(cmd.access, 'directory', parent(RULES_DIR), leaf(RULES_DIR), { props: { mode: 0o770, ...group } });
  await vfs.ensure(cmd.access, 'directory', parent(parent(RULES_LOG)), leaf(parent(RULES_LOG)), { props: { mode: 0o755 } });
  await vfs.ensure(cmd.access, 'log', parent(RULES_LOG), leaf(RULES_LOG), { props: { mode: 0o640, ...group }, attrs: { retention: '30 day' } });
  await vfs.ensure(cmd.access, 'queue', parent(RULES_QUEUE), leaf(RULES_QUEUE), { attrs: { routingKeys: RULES_KEYS } });
  await vfs.update(cmd.access, RULES_QUEUE, { attrs: { routingKeys: RULES_KEYS } });

  let files: RuleFile[] = [];
  let running: Promise<void> = Promise.resolve();
  const state = { rules: () => engine.ruleCount(), problems: () => files.filter((file) => file.problem).map((file) => `${file.name}: ${file.problem}`), runs: 0 };

  const runLines = async ({ rule, why }: Firing): Promise<void> => {
    const owner = files.find((file) => file.rule === rule)?.owner;
    if (owner === undefined) return;
    const lines: LineResult[] = [];
    for (const line of rule.then) {
      const result = await cmd.execute(`runas ${owner} ${shq(line)}`).catch((error) => ({ code: 1, stdout: '', stderr: String(error) }));
      lines.push({ line, code: result.code, ...(result.code !== 0 && result.stderr.trim() ? { error: result.stderr.trim().slice(0, 500) } : {}) });
      if (result.code !== 0) break;
    }
    state.runs++;
    const failed = lines.find((each) => each.code !== 0);
    await log(`${rule.name} ran on ${why}${failed ? `; ${failed.line} failed (${failed.code})` : ''}`);
    const handle = await vfs.open(cmd.access, RULES_LOG, { mode: 'a' });
    try {
      await handle.write(encoder.encode(JSON.stringify({ rule: rule.name, why, lines, at: new Date().toISOString() }) + '\n'));
    } finally {
      await handle.close();
    }
  };

  const engine = new RuleEngine({
    run: (firing) => {
      running = running.then(() => runLines(firing)).catch((error) => log(`${firing.rule.name}: ${error}`));
    },
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    now: () => Date.now(),
    localTime,
  });

  const load = async () => {
    files = await readRuleFiles(cmd);
    const rules = files.flatMap((file) => file.rule ? [file.rule] : []);
    engine.load(rules);
    for (const [key, value] of await latestValues(cmd, rules)) engine.seed(key, value);
    for (const [device, online] of await onlineDevices(cmd)) engine.seedOnline(device, online);
    await log(`${rules.length} rules${files.some((file) => file.problem) ? `; not run: ${state.problems().join('; ')}` : ''}`);
  };

  let reload: ReturnType<typeof setTimeout> | undefined;
  const subscription = await vfs.subscribe?.(() => cmd.access, () => {
    clearTimeout(reload);
    reload = setTimeout(() => load().catch((error) => log(`reading the rules: ${error}`)), RELOAD_DELAY_MS);
  }, { pathPrefix: RULES_DIR });

  await load();
  setRulesState(state);
  const clock = setInterval(() => engine.tick(Date.now()), TICK_MS);
  engine.tick(Date.now());

  const abort = new AbortController();
  stopped.then(() => abort.abort());
  let queue: ResourceHandleIf | undefined;
  try {
    queue = await vfs.open(cmd.access, RULES_QUEUE, { mode: 'r+' });
    while (!stopping) {
      const bytes = await queue.read(1, abort.signal);
      if (bytes.length === 0) continue;
      try {
        const message = messageOf(JSON.parse(decoder.decode(bytes)));
        if (message) engine.handle(message);
      } catch (error) {
        await log(`a message it could not read: ${error}`);
      }
      await queue.write(encoder.encode('ack\n'));
    }
  } finally {
    clearInterval(clock);
    clearTimeout(reload);
    engine.load([]);
    await subscription?.unsubscribe().catch(() => {});
    await queue?.close().catch(() => {});
    await running;
    setRulesState(undefined);
    await log('stopped');
  }
};
