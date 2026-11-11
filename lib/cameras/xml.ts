/**
 * Just enough XML for a camera's SOAP answers: elements found by their local name, since each camera
 * picks its own prefixes, with their attributes (by local name too) and text. An element keeps its
 * name as written and its namespace, so it can be sent back as it came. Comments, processing
 * instructions and the doctype are skipped; CDATA is text.
 */

export type XmlElement = {
  /** Its local name, without the prefix. */
  name: string;
  /** Its name as written, with the prefix. */
  qname: string;
  /** The namespace its prefix stands for, where one is declared. */
  ns?: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const unescape = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, entity: string) => {
    if (entity[0] !== '#') return ENTITIES[entity] ?? whole;
    const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
  });

/** Escapes text for an element's content or an attribute's value. */
export const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const local = (name: string): string => name.slice(name.indexOf(':') + 1);

const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** The document's root element; throws on text that is not XML. */
export const parseXml = (text: string): XmlElement => {
  const root: XmlElement = { name: '', qname: '', attrs: {}, children: [], text: '' };
  const stack = [root];
  /** The namespaces declared on each open element and its ancestors, by prefix ('' for the default). */
  const scopes: Record<string, string>[] = [{}];
  let at = 0;
  /** Where `token` ends, from `from` on; throws when the text ends first. */
  const past = (token: string, from: number): number => {
    const found = text.indexOf(token, from);
    if (found === -1) throw new Error(`'${text.slice(from, from + 20)}' runs past the end`);
    return found + token.length;
  };
  while (at < text.length) {
    const open = text.indexOf('<', at);
    const top = stack[stack.length - 1];
    if (open === -1) {
      top.text += unescape(text.slice(at));
      break;
    }
    if (open > at) top.text += unescape(text.slice(at, open));
    if (text.startsWith('<!--', open)) {
      at = past('-->', open);
    } else if (text.startsWith('<![CDATA[', open)) {
      at = past(']]>', open);
      top.text += text.slice(open + 9, at - 3);
    } else if (text[open + 1] === '?' || text[open + 1] === '!') {
      at = past('>', open);
    } else if (text[open + 1] === '/') {
      at = past('>', open);
      if (stack.length > 1) {
        stack.pop();
        scopes.pop();
      }
    } else {
      const end = past('>', open) - 1;
      const tag = text.slice(open + 1, end);
      const closed = tag.endsWith('/');
      const body = closed ? tag.slice(0, -1) : tag;
      const name = body.match(/^[^\s/>]+/)?.[0];
      if (!name) throw new Error('an element without a name');
      const scope = { ...scopes[scopes.length - 1] };
      const attrs: Record<string, string> = {};
      for (const match of body.slice(name.length).matchAll(ATTR)) {
        const value = unescape(match[2] ?? match[3] ?? '');
        if (match[1] === 'xmlns') scope[''] = value;
        else if (match[1].startsWith('xmlns:')) scope[match[1].slice(6)] = value;
        else attrs[local(match[1])] = value;
      }
      const prefix = name.includes(':') ? name.slice(0, name.indexOf(':')) : '';
      const element: XmlElement = { name: local(name), qname: name, ...(scope[prefix] ? { ns: scope[prefix] } : {}), attrs, children: [], text: '' };
      top.children.push(element);
      if (!closed) {
        stack.push(element);
        scopes.push(scope);
      }
      at = end + 1;
    }
  }
  const element = root.children[0];
  if (!element) throw new Error('no element');
  return element;
};

/** The first element under `from`, at any depth, with the local name `name`. */
export const find = (from: XmlElement | undefined, name: string): XmlElement | undefined => {
  if (!from) return undefined;
  for (const child of from.children) {
    if (child.name === name) return child;
    const deeper = find(child, name);
    if (deeper) return deeper;
  }
  return undefined;
};

/** Every element under `from`, at any depth, with the local name `name`, outermost first. */
export const findAll = (from: XmlElement | undefined, name: string): XmlElement[] => {
  if (!from) return [];
  return from.children.flatMap((child) => child.name === name ? [child] : findAll(child, name));
};

/** The first child of `from` itself with the local name `name`. */
export const child = (from: XmlElement | undefined, name: string): XmlElement | undefined => from?.children.find((each) => each.name === name);

/** The trimmed text of the first `name` under `from`; undefined when there is none or it is empty. */
export const textOf = (from: XmlElement | undefined, name: string): string | undefined => find(from, name)?.text.trim() || undefined;

/**
 * The element written out again with its children, each declaring its own namespace: for what a
 * camera gave to be sent back, as a subscription's reference parameters are.
 */
export const writeXml = (element: XmlElement): string => {
  const prefix = element.qname.includes(':') ? element.qname.slice(0, element.qname.indexOf(':')) : '';
  const ns = element.ns ? ` xmlns${prefix ? `:${prefix}` : ''}="${escapeXml(element.ns)}"` : '';
  const attrs = Object.entries(element.attrs).map(([key, value]) => ` ${key}="${escapeXml(value)}"`).join('');
  const inner = escapeXml(element.text.trim()) + element.children.map(writeXml).join('');
  return `<${element.qname}${ns}${attrs}>${inner}</${element.qname}>`;
};
