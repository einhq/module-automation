/**
 * The expressions of a math node: `value * 1.8 + 32`, `round(value, 1)`, `outdoor - indoor`,
 * `value > 25 ? 'warm' : 'cool'`. Parsed once, evaluated per message, never by `eval`.
 *
 * Numbers, 'text' or "text", true and on, false and off, null; names (`value`, `topic`, and each sender's latest
 * value under its node id with dashes as underscores); `+ - * / %` (`+` joins text), comparisons
 * (`==` and `!=` as a compare node's `is` and `not`), `&&` `||` `!` (or `and` `or` `not`), `a ? b : c`,
 * and round(x, digits?), floor, ceil, abs, min, max, avg, sum, clamp(x, low, high).
 *
 * Import-free but for its own module's files, so the editor checks an expression as it is typed.
 */

import type { AutomationValue as Value } from '../api.ts';
import { numeric, round, same, truthy } from './values.ts';

type Expr =
  | { kind: 'literal'; value: Value }
  | { kind: 'name'; name: string }
  | { kind: 'unary'; op: '-' | '!'; arg: Expr }
  | { kind: 'binary'; op: string; left: Expr; right: Expr }
  | { kind: 'if'; test: Expr; then: Expr; else: Expr }
  | { kind: 'call'; fn: string; args: Expr[] };

type Token = { kind: 'number' | 'string' | 'name' | 'op' | 'end'; text: string; value?: Value; at: number };

const FUNCTIONS: Record<string, { min: number; max: number }> = {
  round: { min: 1, max: 2 },
  floor: { min: 1, max: 1 },
  ceil: { min: 1, max: 1 },
  abs: { min: 1, max: 1 },
  min: { min: 1, max: Infinity },
  max: { min: 1, max: Infinity },
  avg: { min: 1, max: Infinity },
  sum: { min: 1, max: Infinity },
  clamp: { min: 3, max: 3 },
};

const OPS = ['&&', '||', '==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '%', '!', '?', ':', '(', ')', ','];

const tokenize = (text: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const number = /^(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?/.exec(text.slice(i));
    if (number) {
      tokens.push({ kind: 'number', text: number[0], value: Number(number[0]), at: i });
      i += number[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      if (end < 0) throw new Error(`the text at ${i + 1} is not closed with ${c}`);
      tokens.push({ kind: 'string', text: text.slice(i, end + 1), value: text.slice(i + 1, end), at: i });
      i = end + 1;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
    if (name) {
      tokens.push({ kind: 'name', text: name[0], at: i });
      i += name[0].length;
      continue;
    }
    const op = OPS.find((each) => text.startsWith(each, i));
    if (!op) throw new Error(`${JSON.stringify(c)} at ${i + 1} is not understood`);
    tokens.push({ kind: 'op', text: op, at: i });
    i += op.length;
  }
  tokens.push({ kind: 'end', text: 'the end', at: text.length });
  return tokens;
};

const WORD_OPS: Record<string, string> = { and: '&&', or: '||', not: '!' };

/** An expression, or the error that says where it is wrong. */
export const parseExpression = (text: string): Expr => {
  const tokens = tokenize(text).map((token) => token.kind === 'name' && WORD_OPS[token.text] ? { ...token, kind: 'op' as const, text: WORD_OPS[token.text] } : token);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (op?: string) => {
    const token = tokens[pos];
    if (op !== undefined && !(token.kind === 'op' && token.text === op)) throw new Error(`expected ${op} at ${token.at + 1}, not ${token.text}`);
    pos++;
    return token;
  };
  const isOp = (...ops: string[]) => peek().kind === 'op' && ops.includes(peek().text);

  const binary = (next: () => Expr, ops: string[]) => (): Expr => {
    let left = next();
    while (isOp(...ops)) {
      const op = take().text;
      left = { kind: 'binary', op, left, right: next() };
    }
    return left;
  };

  const primary = (): Expr => {
    const token = take();
    if (token.kind === 'number' || token.kind === 'string') return { kind: 'literal', value: token.value! };
    if (token.kind === 'name') {
      if (['true', 'on', 'false', 'off'].includes(token.text)) return { kind: 'literal', value: token.text === 'true' || token.text === 'on' };
      if (token.text === 'null') return { kind: 'literal', value: null };
      if (isOp('(')) {
        const spec = FUNCTIONS[token.text];
        if (!spec) throw new Error(`${token.text} is no function; there are ${Object.keys(FUNCTIONS).join(', ')}`);
        take('(');
        const args: Expr[] = [];
        if (!isOp(')')) {
          args.push(expression());
          while (isOp(',')) {
            take(',');
            args.push(expression());
          }
        }
        take(')');
        if (args.length < spec.min || args.length > spec.max) {
          throw new Error(`${token.text} takes ${spec.min === spec.max ? spec.min : `${spec.min} or more`} values, not ${args.length}`);
        }
        return { kind: 'call', fn: token.text, args };
      }
      return { kind: 'name', name: token.text };
    }
    if (token.kind === 'op' && token.text === '(') {
      const inner = expression();
      take(')');
      return inner;
    }
    throw new Error(`expected a value at ${token.at + 1}, not ${token.text}`);
  };
  const unary = (): Expr => isOp('-', '!') ? { kind: 'unary', op: take().text as '-' | '!', arg: unary() } : primary();
  const product = binary(unary, ['*', '/', '%']);
  const sum = binary(product, ['+', '-']);
  const comparison = binary(sum, ['==', '!=', '<', '<=', '>', '>=']);
  const conjunction = binary(comparison, ['&&']);
  const disjunction = binary(conjunction, ['||']);
  const expression = (): Expr => {
    const test = disjunction();
    if (!isOp('?')) return test;
    take('?');
    const then = expression();
    take(':');
    return { kind: 'if', test, then, else: expression() };
  };

  if (!text.trim()) throw new Error('the expression is empty');
  const expr = expression();
  if (peek().kind !== 'end') throw new Error(`${peek().text} at ${peek().at + 1} is not understood`);
  return expr;
};

/** The names an expression reads. */
export const namesIn = (expr: Expr): string[] => {
  switch (expr.kind) {
    case 'literal':
      return [];
    case 'name':
      return [expr.name];
    case 'unary':
      return namesIn(expr.arg);
    case 'binary':
      return [...new Set([...namesIn(expr.left), ...namesIn(expr.right)])];
    case 'if':
      return [...new Set([...namesIn(expr.test), ...namesIn(expr.then), ...namesIn(expr.else)])];
    case 'call':
      return [...new Set(expr.args.flatMap(namesIn))];
  }
};

/** A name that has no value yet: the math node waits for it rather than failing. */
export class NoValueYet extends Error {
  constructor(readonly missing: string) {
    super(`${missing} has no value yet`);
  }
}

const num = (value: Value, what: string): number => {
  const n = numeric(value);
  if (n === undefined) throw new Error(`${what} takes a number, not ${JSON.stringify(value)}`);
  return n;
};

/** The value of an expression, with `names` the values it may read. */
export const evaluate = (expr: Expr, names: Record<string, Value | undefined>): Value => {
  const run = (e: Expr): Value => {
    switch (e.kind) {
      case 'literal':
        return e.value;
      case 'name': {
        if (!(e.name in names)) throw new Error(`${e.name} is not a name this node knows`);
        const value = names[e.name];
        if (value === undefined) throw new NoValueYet(e.name);
        return value;
      }
      case 'unary':
        return e.op === '!' ? !truthy(run(e.arg)) : -num(run(e.arg), '-');
      case 'if':
        return truthy(run(e.test)) ? run(e.then) : run(e.else);
      case 'call': {
        const args = e.args.map(run);
        const ns = () => args.map((arg) => num(arg, e.fn));
        switch (e.fn) {
          case 'round': {
            const scale = 10 ** (args[1] === undefined ? 0 : num(args[1], 'round'));
            return Math.round(num(args[0], 'round') * scale) / scale;
          }
          case 'floor':
            return Math.floor(num(args[0], 'floor'));
          case 'ceil':
            return Math.ceil(num(args[0], 'ceil'));
          case 'abs':
            return Math.abs(num(args[0], 'abs'));
          case 'min':
            return Math.min(...ns());
          case 'max':
            return Math.max(...ns());
          case 'avg':
            return round(ns().reduce((a, b) => a + b, 0) / args.length);
          case 'sum':
            return round(ns().reduce((a, b) => a + b, 0));
          case 'clamp': {
            const [x, low, high] = ns();
            return Math.min(Math.max(x, low), high);
          }
        }
        throw new Error(`${e.fn} is no function`);
      }
      case 'binary': {
        if (e.op === '&&') return truthy(run(e.left)) && truthy(run(e.right));
        if (e.op === '||') return truthy(run(e.left)) || truthy(run(e.right));
        const a = run(e.left), b = run(e.right);
        switch (e.op) {
          case '==':
            return same(a, b);
          case '!=':
            return !same(a, b);
          case '+':
            if (typeof a === 'string' && numeric(a) === undefined || typeof b === 'string' && numeric(b) === undefined) return `${a ?? ''}${b ?? ''}`;
            return round(num(a, '+') + num(b, '+'));
          case '-':
            return round(num(a, '-') - num(b, '-'));
          case '*':
            return round(num(a, '*') * num(b, '*'));
          case '/': {
            const d = num(b, '/');
            if (d === 0) throw new Error('division by zero');
            return round(num(a, '/') / d);
          }
          case '%':
            return num(a, '%') % num(b, '%');
          case '<':
            return num(a, '<') < num(b, '<');
          case '<=':
            return num(a, '<=') <= num(b, '<=');
          case '>':
            return num(a, '>') > num(b, '>');
          case '>=':
            return num(a, '>=') >= num(b, '>=');
        }
        throw new Error(`${e.op} is not understood`);
      }
    }
  };
  return run(expr);
};

export type { Expr as Expression };
