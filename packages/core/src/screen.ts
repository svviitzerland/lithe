import { attrsOf, color, type Style } from "./style.ts";
import { cells, strWidth, truncate } from "./width.ts";
import type { Frame, PalEntry, Run } from "./frame.ts";

const CONT = ""; // continuation cell of a double-width character

/**
 * A fixed-size grid of styled cells. Every widget ultimately writes here, and
 * the grid serializes to a `Frame`. Styles are interned on write so the frame
 * carries each distinct style once.
 */
export class Screen {
  readonly w: number;
  readonly h: number;
  private ch: string[];
  private st: Int32Array;
  private pal: PalEntry[] = [{}];
  private palIdx = new Map<string, number>([["||0", 0]]);
  cursor: [number, number] | undefined;
  title: string | undefined;
  bell = false;

  constructor(w: number, h: number) {
    this.w = Math.max(1, w | 0);
    this.h = Math.max(1, h | 0);
    this.ch = new Array(this.w * this.h).fill(" ");
    this.st = new Int32Array(this.w * this.h);
  }

  private intern(s: Style | undefined): number {
    if (!s) return 0;
    const fg = color(s.fg);
    const bg = color(s.bg);
    const at = attrsOf(s);
    if (fg === undefined && bg === undefined && at === 0) return 0;
    const key = `${fg ?? ""}|${bg ?? ""}|${at}`;
    const hit = this.palIdx.get(key);
    if (hit !== undefined) return hit;
    const e: PalEntry = {};
    if (fg !== undefined) e.fg = fg;
    if (bg !== undefined) e.bg = bg;
    if (at !== 0) e.at = at;
    const idx = this.pal.push(e) - 1;
    this.palIdx.set(key, idx);
    return idx;
  }

  /** Write one cell cluster. `text` must be a single grapheme of width `w`. */
  private put(x: number, y: number, text: string, w: number, pi: number): void {
    if (y < 0 || y >= this.h || x < 0 || x >= this.w) return;
    const i = y * this.w + x;
    // Writing over the left half of a wide char leaves an orphan continuation.
    if (this.ch[i] === CONT && x > 0) this.ch[i - 1] = " ";
    if (w === 2 && x + 1 < this.w && this.ch[i + 1] === CONT) {
      // fine, we are about to overwrite it anyway
    }
    this.ch[i] = text;
    this.st[i] = pi;
    if (w === 2) {
      if (x + 1 < this.w) {
        this.ch[i + 1] = CONT;
        this.st[i + 1] = pi;
      } else {
        this.ch[i] = " "; // wide char would straddle the right edge
      }
    }
  }

  /** Draw a single line of text, clipped to `maxW` columns. Returns columns used. */
  text(x: number, y: number, s: string, style?: Style, maxW = this.w - x): number {
    if (maxW <= 0) return 0;
    const pi = this.intern(style);
    let cx = x;
    let used = 0;
    for (const [g, gw] of cells(s)) {
      if (used + gw > maxW) break;
      this.put(cx, y, g, gw, pi);
      cx += gw;
      used += gw;
    }
    return used;
  }

  fill(x: number, y: number, w: number, h: number, chr = " ", style?: Style): void {
    const pi = this.intern(style);
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) this.put(xx, yy, chr, 1, pi);
    }
  }

  /** Paint a background over a region without disturbing the glyphs already there. */
  shade(x: number, y: number, w: number, h: number, style: Style): void {
    const pi = this.intern(style);
    for (let yy = Math.max(0, y); yy < Math.min(this.h, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.w, x + w); xx++) {
        this.st[yy * this.w + xx] = pi;
      }
    }
  }

  border(x: number, y: number, w: number, h: number, g: BorderGlyphs, style?: Style, title?: string): void {
    if (w < 2 || h < 2) return;
    const pi = this.intern(style);
    this.put(x, y, g.tl, 1, pi);
    this.put(x + w - 1, y, g.tr, 1, pi);
    this.put(x, y + h - 1, g.bl, 1, pi);
    this.put(x + w - 1, y + h - 1, g.br, 1, pi);
    for (let i = 1; i < w - 1; i++) {
      this.put(x + i, y, g.h, 1, pi);
      this.put(x + i, y + h - 1, g.h, 1, pi);
    }
    for (let i = 1; i < h - 1; i++) {
      this.put(x, y + i, g.v, 1, pi);
      this.put(x + w - 1, y + i, g.v, 1, pi);
    }
    if (title && w > 4) {
      const t = ` ${truncate(title, w - 4)} `;
      this.text(x + 1, y, t, style, w - 2);
    }
  }

  toFrame(): Frame {
    const rows: Run[][] = [];
    for (let y = 0; y < this.h; y++) {
      const runs: Run[] = [];
      let cur = "";
      let curPi = -1;
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x;
        const c = this.ch[i]!;
        if (c === CONT) continue; // carried by the preceding wide glyph
        const pi = this.st[i]!;
        if (pi !== curPi) {
          if (cur !== "") runs.push([cur, curPi]);
          cur = "";
          curPi = pi;
        }
        cur += c;
      }
      if (cur !== "") runs.push([cur, curPi === -1 ? 0 : curPi]);
      // Trailing default-styled whitespace is implied by the row width.
      while (runs.length > 0) {
        const last = runs[runs.length - 1]!;
        if (last[1] === 0 && last[0].trim() === "") runs.pop();
        else break;
      }
      rows.push(runs);
    }
    const f: Frame = { w: this.w, h: this.h, pal: this.pal, rows };
    if (this.cursor) f.cursor = this.cursor;
    if (this.title) f.title = this.title;
    if (this.bell) f.bell = true;
    return f;
  }
}

export interface BorderGlyphs {
  tl: string; tr: string; bl: string; br: string; h: string; v: string;
}

export const BORDERS = {
  round: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  single: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
  thick: { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" },
  ascii: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" },
  none: { tl: " ", tr: " ", bl: " ", br: " ", h: " ", v: " " },
} satisfies Record<string, BorderGlyphs>;

export type BorderName = keyof typeof BORDERS;

/** Wrap text to a column budget, honouring existing newlines. */
export function wrap(s: string, width: number): string[] {
  if (width <= 0) return [];
  const out: string[] = [];
  for (const para of s.split("\n")) {
    if (strWidth(para) <= width) {
      out.push(para);
      continue;
    }
    let line = "";
    for (const word of para.split(" ")) {
      const cand = line === "" ? word : `${line} ${word}`;
      if (strWidth(cand) <= width) {
        line = cand;
        continue;
      }
      if (line !== "") out.push(line);
      if (strWidth(word) <= width) {
        line = word;
      } else {
        // A single word longer than the line: hard-break it.
        let chunk = "";
        for (const [g, gw] of cells(word)) {
          if (strWidth(chunk) + gw > width) {
            out.push(chunk);
            chunk = "";
          }
          chunk += g;
        }
        line = chunk;
      }
    }
    out.push(line);
  }
  return out;
}
