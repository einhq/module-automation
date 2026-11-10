/** A colour as `#rrggbb`, the way a colour entity's state and command say it. */

export type Rgb = [number, number, number];

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

const unit = (value: unknown, max: number): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value / max : undefined;

const hexOfUnits = (rgb: number[]): string | undefined => hexOf(...rgb.map((value) => Math.round(Math.min(1, Math.max(0, value)) * 255)) as Rgb);

/** `#rrggbb` from a hue of 0–360 and a saturation of 0–100, at full brightness. */
export const hexOfHs = (hue: unknown, saturation: unknown): string | undefined => {
  const h = unit(hue, 360);
  const s = unit(saturation, 100);
  if (h === undefined || s === undefined) return undefined;
  const at = (n: number) => {
    const k = (n + h * 6) % 6;
    return 1 - s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return hexOfUnits([at(5), at(3), at(1)]);
};

/** Hue (0–360) and saturation (0–100) of red, green and blue. */
export const hsOf = ([red, green, blue]: Rgb): { h: number; s: number } => {
  const max = Math.max(red, green, blue);
  const span = max - Math.min(red, green, blue);
  if (span === 0) return { h: 0, s: 0 };
  const hue = max === red ? (green - blue) / span : max === green ? 2 + (blue - red) / span : 4 + (red - green) / span;
  return { h: Math.round(((hue * 60) + 360) % 360), s: Math.round(span / max * 100) };
};

const linear = (channel: number): number => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
const gamma = (value: number): number => value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;

/** `#rrggbb` from CIE 1931 x and y (sRGB), at full brightness. */
export const hexOfXy = (x: unknown, y: unknown): string | undefined => {
  const cx = unit(x, 1);
  const cy = unit(y, 1);
  if (cx === undefined || !cy) return undefined;
  const X = cx / cy;
  const Z = (1 - cx - cy) / cy;
  const rgb = [
    X * 3.2406 - 1.5372 - Z * 0.4986,
    -X * 0.9689 + 1.8758 + Z * 0.0415,
    X * 0.0557 - 0.204 + Z * 1.057,
  ].map((value) => Math.max(0, value));
  const max = Math.max(...rgb);
  return max > 0 ? hexOfUnits(rgb.map((value) => gamma(value / max))) : undefined;
};

/** CIE 1931 x and y of red, green and blue (sRGB); undefined for black, which has none. */
export const xyOf = (rgb: Rgb): { x: number; y: number } | undefined => {
  const [r, g, b] = rgb.map((channel) => linear(channel / 255));
  const X = r * 0.4124 + g * 0.3576 + b * 0.1805;
  const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const Z = r * 0.0193 + g * 0.1192 + b * 0.9505;
  const sum = X + Y + Z;
  if (sum === 0) return undefined;
  return { x: Math.round(X / sum * 10000) / 10000, y: Math.round(Y / sum * 10000) / 10000 };
};
