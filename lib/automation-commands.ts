/**
 * What automation's commands share: an automation named by its name or its file, as the caller
 * sees it, with whether the engine runs it.
 */

import { ADMIN_ACCESS, type Command, isAdmin, verifyAccess } from '@ein/client';
import type { AutomationDetail, AutomationProblem, AutomationSpec, AutomationSummary } from './api.ts';
import { accounts, type AutomationFile, automationName, automationPath, isAutomationName, moduleSwitches, readAutomationFile } from './automation-files.ts';
import { placeNodes } from './automations/layout.ts';
import { engineState } from './state.ts';

/** The automation an argument names: `<name>`, `<module>/<name>`, or its file's path. */
export const resolveAutomation = (arg: string | undefined): { name: string; path: string } => {
  if (!arg) throw new Error('name an automation: <name>, <module>/<name>, or its file');
  if (arg.startsWith('/')) {
    const name = automationName(arg);
    if (!name) throw new Error(`${arg} is no automation's file: they are /etc/automations/<name>.yaml and /etc/automations.d/<module>/<name>.yaml`);
    return { name, path: arg };
  }
  const name = arg.replace(/\.yaml$/, '');
  if (!isAutomationName(name)) throw new Error(`${arg} is no automation's name: letters, digits, '.', '-' and '_'`);
  return { name, path: automationPath(name) };
};

/** An automation's file, read as the caller. */
export const readAs = async (cmd: Command, path: string): Promise<AutomationFile> =>
  await readAutomationFile(cmd.sys.vfs, cmd.access, path, path.includes('/automations.d/') ? await moduleSwitches(cmd.sys.vfs) : {});

/** Whether the caller may change an automation: its file, or for a module's, being the administrator. */
export const mayChange = async (cmd: Command, file: AutomationFile): Promise<boolean> => {
  if (file.module) return isAdmin(cmd.access);
  const node = await cmd.sys.vfs.get(cmd.access, file.path).catch(() => undefined);
  return node !== undefined && verifyAccess(cmd.access, node.props, 'w');
};

/** The problems the engine has with it beside its own: rights its owner lacks. */
const engineProblems = (name: string): AutomationProblem[] => engineState()?.known().get(name)?.problems ?? [];

export const summaryOf = async (cmd: Command, file: AutomationFile, names = accounts(cmd.sys.vfs)): Promise<AutomationSummary> => {
  const engine = engineState()?.known().get(file.name);
  const problems = file.problems.length ? file.problems : engineProblems(file.name);
  return {
    name: file.name,
    path: file.path,
    ...(file.module ? { module: file.module } : {}),
    owner: file.module ? 'admin' : await names.nameOf(file.owner),
    ...(file.spec?.description ? { description: String(file.spec.description) } : {}),
    enabled: file.enabled,
    running: engine?.running ?? false,
    nodes: file.spec?.nodes && typeof file.spec.nodes === 'object' ? Object.keys(file.spec.nodes).length : 0,
    problems,
    writable: await mayChange(cmd, file),
  };
};

/** The graph with every node placed: those without `pos` where the layout puts them. */
const placedSpec = (spec: AutomationSpec): AutomationSpec => {
  const nodes = spec.nodes && typeof spec.nodes === 'object' ? spec.nodes : {};
  const targets = (to: unknown): string[] => Array.isArray(to) ? to : to && typeof to === 'object' ? Object.values(to).flat() as string[] : [];
  const places = placeNodes(Object.entries(nodes).map(([id, node]) => ({ id, ...(node?.pos ? { pos: node.pos } : {}), targets: targets(node?.to) })));
  return { ...spec, nodes: Object.fromEntries(Object.entries(nodes).map(([id, node]) => [id, places.has(id) ? { ...node, pos: places.get(id)! } : node])) };
};

export const detailOf = async (cmd: Command, file: AutomationFile): Promise<AutomationDetail> => ({
  ...await summaryOf(cmd, file),
  text: file.text,
  ...(file.spec && typeof file.spec === 'object' ? { spec: placedSpec(file.spec) } : {}),
});

/** Turn an automation on or off: a person's by its file's attr, a module's in the administrator's switches. */
export const setEnabled = async (cmd: Command, file: AutomationFile, enabled: boolean): Promise<void> => {
  if (!(await mayChange(cmd, file))) {
    throw new Error(file.module ? `${file.name} is the ${file.module} module's: only the administrator turns it on or off` : `you may not change ${file.name}`);
  }
  if (file.module) {
    const switches = { ...await moduleSwitches(cmd.sys.vfs), [file.name]: enabled };
    await cmd.sys.vfs.update(ADMIN_ACCESS, '/etc/automations.d', { attrs: { enabled: switches } });
  } else {
    await cmd.sys.vfs.update(cmd.access, file.path, { attrs: { enabled } });
  }
  await engineState()?.reload();
};

/** Write a problem list as a person reads it. */
export const problemLines = (problems: AutomationProblem[]): string[] => problems.map((problem) => `  ${problem.node ? `${problem.node}: ` : ''}${problem.message}`);
