/** A color is either a 0-255 xterm palette index, or a "#rrggbb" truecolor string. */
export type Color = number | string;

export interface Style {
  fg?: Color;
  bg?: Color;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  reverse?: boolean;
  strike?: boolean;
}

export const ATTR = {
  bold: 1,
  dim: 2,
  italic: 4,
  underline: 8,
  reverse: 16,
  strike: 32,
} as const;

/** 16 ANSI names -> palette index, so authors can write `fg: "cyan"`. */
const NAMED: Record<string, number> = {
  black: 0, red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6, white: 7,
  gray: 8, grey: 8, brightred: 9, brightgreen: 10, brightyellow: 11,
  brightblue: 12, brightmagenta: 13, brightcyan: 14, brightwhite: 15,
};

/** Normalize a user-supplied color into the wire form: palette index or "#rrggbb". */
export function color(c: Color | undefined): Color | undefined {
  if (c === undefined) return undefined;
  if (typeof c === "number") return c >= 0 && c <= 255 ? (c | 0) : undefined;
  const s = c.trim().toLowerCase();
  if (s in NAMED) return NAMED[s];
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  if (/^\d{1,3}$/.test(s)) return color(Number(s));
  return undefined;
}

export function attrsOf(s: Style | undefined): number {
  if (!s) return 0;
  let a = 0;
  if (s.bold) a |= ATTR.bold;
  if (s.dim) a |= ATTR.dim;
  if (s.italic) a |= ATTR.italic;
  if (s.underline) a |= ATTR.underline;
  if (s.reverse) a |= ATTR.reverse;
  if (s.strike) a |= ATTR.strike;
  return a;
}

/** Later style wins, but only for keys it actually sets. */
export function merge(...styles: (Style | undefined)[]): Style {
  const out: Style = {};
  for (const s of styles) if (s) Object.assign(out, s);
  return out;
}
