/**
 * The part of Home Assistant's value templates (Jinja) the bridge reads:
 *
 *   {{ value }}                       the payload as it came
 *   {{ value_json.a.b }}              a field of the payload read as JSON
 *   {{ value_json['a'].b }}           the same, with a key that is not a name
 *   … | float, | int, | round(n)      made a number
 *
 * Anything else is unsupported, and `compileTemplate` says so rather than guess.
 */

export type Template = (payload: string) => unknown;

type Step = string | number;

const FILTER = /^(float|int|round(?:\((\d+)\))?|lower|upper|trim)$/;

/** Fields of `value_json…`: `.a`, `['a']`, `["a"]`, `[0]`. */
const parsePath = (rest: string): Step[] | undefined => {
  const steps: Step[] = [];
  const part = /^(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*(?:'([^']*)'|"([^"]*)"|(\d+))\s*\])/;
  let left = rest;
  while (left) {
    const match = part.exec(left);
    if (!match) return undefined;
    steps.push(match[1] ?? match[2] ?? match[3] ?? Number(match[4]));
    left = left.slice(match[0].length);
  }
  return steps;
};

const toNumber = (value: unknown): number | undefined => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
};

/** The template as a function of the payload, or the reason it cannot be read. */
export const compileTemplate = (template: string): Template | { problem: string } => {
  const body = /^\s*\{\{\s*(.*?)\s*\}\}\s*$/s.exec(template)?.[1];
  if (body === undefined) return { problem: `template not understood: ${template}` };
  const [head, ...filters] = body.split('|').map((part) => part.trim());
  let read: (payload: string) => unknown;
  if (head === 'value') {
    read = (payload) => payload;
  } else if (head.startsWith('value_json')) {
    const path = parsePath(head.slice('value_json'.length));
    if (!path) return { problem: `template not understood: ${template}` };
    read = (payload) => {
      let at: unknown;
      try {
        at = JSON.parse(payload);
      } catch {
        return undefined;
      }
      for (const step of path) {
        if (at === null || typeof at !== 'object') return undefined;
        at = (at as Record<string | number, unknown>)[step];
      }
      return at;
    };
  } else {
    return { problem: `template not understood: ${template}` };
  }
  const steps: ((value: unknown) => unknown)[] = [];
  for (const filter of filters) {
    const match = FILTER.exec(filter);
    if (!match) return { problem: `template filter not understood: ${filter}` };
    if (match[1] === 'float') steps.push((value) => toNumber(value));
    else if (match[1] === 'int') steps.push((value) => ((n) => n === undefined ? undefined : Math.trunc(n))(toNumber(value)));
    else if (match[1].startsWith('round')) {
      const digits = Number(match[2] ?? 0);
      steps.push((value) => ((n) => n === undefined ? undefined : Number(n.toFixed(digits)))(toNumber(value)));
    } else if (match[1] === 'lower') steps.push((value) => typeof value === 'string' ? value.toLowerCase() : value);
    else if (match[1] === 'upper') steps.push((value) => typeof value === 'string' ? value.toUpperCase() : value);
    else steps.push((value) => typeof value === 'string' ? value.trim() : value);
  }
  return (payload) => steps.reduce((value, step) => step(value), read(payload));
};
