/** A colour as `#rrggbb`, the way a colour entity's state and command say it. */

type Rgb = [number, number, number];

const channel = (value: unknown): number | undefined => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255 ? value : undefined;

/** `#rrggbb` from red, green and blue of 0–255; undefined when one is not such a number. */
export const hexOf = (red: unknown, green: unknown, blue: unknown): string | undefined => {
  const rgb = [channel(red), channel(green), channel(blue)];
  if (rgb.some((value) => value === undefined)) return undefined;
  return `#${rgb.map((value) => value!.toString(16).padStart(2, '0')).join('')}`;
};

/** Red, green and blue of a colour written as `#rrggbb`, `rrggbb` or `r,g,b`. */
export const rgbOf = (text: string): Rgb | undefined => {
  const value = text.trim();
  const hex = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)];
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length !== 3 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined;
  const rgb = parts.map(Number);
  return rgb.every((part) => part <= 255) ? rgb as Rgb : undefined;
};
