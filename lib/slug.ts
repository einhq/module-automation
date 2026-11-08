/**
 * Names that are safe as a node's name and as one segment of a routing key: lower case letters,
 * digits and single hyphens. A key's segments are separated by dots, so a dot never survives.
 */
export const slug = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** A label from an id: `switch-0-power` → `Switch 0 power`. */
export const labelOf = (id: string): string => {
  const words = id.replace(/[_:-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : id;
};
