/**
 * Minimal display-width table. Two things matter for a cell grid: codepoints that
 * take two columns (CJK, emoji) and codepoints that take none (combining marks).
 * Ranges are sorted; lookup is a binary search.
 */
const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4], [0x17000, 0x18cd5],
  [0x1b000, 0x1b2fb], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a], [0x1f200, 0x1f320], [0x1f32d, 0x1f335], [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440], [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e], [0x1f550, 0x1f567], [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2], [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6fc],
  [0x1f910, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];

const ZERO: [number, number][] = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a],
  [0x064b, 0x065f], [0x0670, 0x0670], [0x06d6, 0x06dc], [0x0730, 0x074a],
  [0x07a6, 0x07b0], [0x0900, 0x0903], [0x093a, 0x093c], [0x0941, 0x0948],
  [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0eb1, 0x0eb1], [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff], [0x20d0, 0x20f0], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f],
  [0x1f3fb, 0x1f3ff], [0xe0100, 0xe01ef],
];

function inRanges(cp: number, ranges: [number, number][]): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid]!;
    if (cp < r[0]) hi = mid - 1;
    else if (cp > r[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

export function charWidth(cp: number): 0 | 1 | 2 {
  if (cp === 0x200d) return 0; // ZWJ: emoji sequences collapse onto the base cell
  if (cp < 0x20) return 0;
  if (cp < 0x7f) return 1;
  if (inRanges(cp, ZERO)) return 0;
  if (inRanges(cp, WIDE)) return 2;
  return 1;
}

/** Display width of a string in terminal columns. */
export function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** Split a string into grapheme-ish cells: [text, width] pairs, zero-width marks attached. */
export function cells(s: string): [string, number][] {
  const out: [string, number][] = [];
  for (const ch of s) {
    const w = charWidth(ch.codePointAt(0)!);
    if (w === 0 && out.length > 0) out[out.length - 1]![0] += ch;
    else out.push([ch, w === 0 ? 1 : w]);
  }
  return out;
}

/** Truncate to a column budget, optionally appending an ellipsis that fits. */
export function truncate(s: string, max: number, ellipsis = "…"): string {
  if (strWidth(s) <= max) return s;
  if (max <= 0) return "";
  const ew = strWidth(ellipsis);
  let w = 0;
  let out = "";
  for (const [ch, cw] of cells(s)) {
    if (w + cw > max - ew) break;
    out += ch;
    w += cw;
  }
  return out + ellipsis;
}
