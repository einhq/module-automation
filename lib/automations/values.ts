/**
 * What an automation's messages carry, and how its nodes read it: a reading as true or false, two
 * values as the same, a number from text, and the aggregates over several values.
 *
 * Import-free but for types, so the editor's page uses it as the engine does.
 */

import type { AutomationValue as Value } from '../api.ts';

const TRUE_WORDS = new Set(['on', 'true', 'yes', 'open']);
const FALSE_WORDS = new Set(['off', 'false', 'no', 'closed', '']);

/** A value as true or false: on, a number other than 0, a word other than off, false, no or closed. */
export const truthy = (value: Value | undefined): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const word = value.trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  const n = Number(word);
  return Number.isFinite(n) ? n !== 0 : true;
};

/** A number, from a number or a number written as text. */
export const numeric = (value: Value | undefined): number | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

/** Whether two values are the same: on and off as true and false, a number as its text. */
export const same = (value: Value | undefined, wanted: Value | undefined): boolean => {
  if (value === undefined || wanted === undefined) return false;
  if (value === null || wanted === null) return value === wanted;
  if (typeof value === 'boolean' || typeof wanted === 'boolean') {
    const word = (v: Value) => typeof v === 'boolean' ? v : TRUE_WORDS.has(String(v).toLowerCase()) ? true : FALSE_WORDS.has(String(v).toLowerCase()) ? false : undefined;
    const a = word(value);
    return a !== undefined && a === word(wanted);
  }
  const a = numeric(value), b = numeric(wanted);
  if (a !== undefined && b !== undefined) return a === b;
  return String(value) === String(wanted);
};

/** The tests of a compare node or a switch's case: all that are given must hold. */
export type Test = { is?: Value; not?: Value; above?: number; below?: number };

export const passes = (test: Test, value: Value | undefined): boolean => {
  if (value === undefined) return false;
  if (test.is !== undefined && !same(value, test.is)) return false;
  if (test.not !== undefined && same(value, test.not)) return false;
  const n = numeric(value);
  if (test.above !== undefined && !(n !== undefined && n > test.above)) return false;
  if (test.below !== undefined && !(n !== undefined && n < test.below)) return false;
  return true;
};

/** A value as a control takes it written: true and false as on and off. */
export const valueText = (value: Value): string | undefined => {
  if (value === null) return undefined;
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return String(value);
};

/** A command's output as a value: a number written as text is a number, nothing is null. */
export const valueOfText = (text: string): Value => {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : trimmed;
};

export const AGGREGATES = ['avg', 'min', 'max', 'sum', 'count', 'any', 'all', 'last'] as const;
export type Aggregate = typeof AGGREGATES[number];

/**
 * An aggregate over values, in the order they came: `avg`, `min`, `max` and `sum` over the numbers
 * among them, `count` of those that are true, `any` and `all` of them true, `last` the newest.
 * Undefined when there is nothing to say: no number for `avg`, no value at all.
 */
export const aggregate = (fn: Aggregate, values: Value[]): Value | undefined => {
  if (values.length === 0) return undefined;
  const numbers = values.map(numeric).filter((n): n is number => n !== undefined);
  switch (fn) {
    case 'avg':
      return numbers.length ? round(numbers.reduce((a, b) => a + b, 0) / numbers.length) : undefined;
    case 'min':
      return numbers.length ? Math.min(...numbers) : undefined;
    case 'max':
      return numbers.length ? Math.max(...numbers) : undefined;
    case 'sum':
      return numbers.length ? round(numbers.reduce((a, b) => a + b, 0)) : undefined;
    case 'count':
      return values.filter(truthy).length;
    case 'any':
      return values.some(truthy);
    case 'all':
      return values.every(truthy);
    case 'last':
      return values[values.length - 1];
  }
};

/** A computed number to the precision its readings have, not a float's noise: 21.450000000000003 is 21.45. */
export const round = (n: number): number => Number(n.toPrecision(12));

/** Whether a file's `name` matches `pattern`, where `*` is any text and `?` one character, upper or lower case alike. */
export const nameMatches = (pattern: string, name: string): boolean => {
  const source = [...pattern].map((char) => char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${source}$`, 'iu').test(name);
};
