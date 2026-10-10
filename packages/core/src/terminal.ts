import type { Frame, PalEntry } from "./frame.ts";
import { charWidth } from "./width.ts";

interface Grid {
  w: number;
  h: number;
  ch: string[];
  st: PalEntry[];
}

const DEFAULT: PalEntry = {};

/** Expand the wire format back into a cell grid we can diff against. */
function expand(f: Frame, prev: Grid | undefined): Grid {
  const ch: string[] = new Array(f.w * f.h).fill(" ");
  const st: PalEntry[] = new Array(f.w * f.h).fill(DEFAULT);
  const reusable = prev && prev.w === f.w && prev.h === f.h ? prev : undefined;
  for (let y = 0; y < f.h; y++) {
    const row = f.rows[y];
    if (row === null || row === undefined) {
      // Unchanged row: carry the previous cells forward verbatim.
      if (reusable) {
        for (let x = 0; x < f.w; x++) {
          ch[y * f.w + x] = reusable.ch[y * f.w + x]!;
          st[y * f.w + x] = reusable.st[y * f.w + x]!;
        }
      }
      continue;
    }
    let x = 0;
    for (const [textRun, pi] of row) {
      const entry = f.pal[pi] ?? DEFAULT;
      for (const g of textRun) {
        if (x >= f.w) break;
        const cw = charWidth(g.codePointAt(0)!);
        const i = y * f.w + x;
        ch[i] = g;
        st[i] = entry;
        if (cw === 2 && x + 1 < f.w) {
          ch[i + 1] = "";
          st[i + 1] = entry;
          x += 2;
        } else {
          x += 1;
        }
      }
    }
  }
  return { w: f.w, h: f.h, ch, st };
}

function sgrColor(c: PalEntry["fg"], fg: boolean, truecolor: boolean): string {
  const base = fg ? 38 : 48;
  if (c === undefined) return String(fg ? 39 : 49);
  if (typeof c === "number") return `${base};5;${c}`;
  const r = parseInt(c.slice(1, 3), 16);
  const g = parseInt(c.slice(3, 5), 16);
  const b = parseInt(c.slice(5, 7), 16);
  if (truecolor) return `${base};2;${r};${g};${b}`;
  // Degrade to the 6x6x6 cube when the terminal has no truecolor.
  const q = (v: number) => Math.round((v / 255) * 5);
  return `${base};5;${16 + 36 * q(r) + 6 * q(g) + q(b)}`;
}

function sgr(e: PalEntry, truecolor: boolean): string {
  const at = e.at ?? 0;
  const codes = ["0"];
  if (at & 1) codes.push("1");
  if (at & 2) codes.push("2");
  if (at & 4) codes.push("3");
  if (at & 8) codes.push("4");
  if (at & 16) codes.push("7");
  if (at & 32) codes.push("9");
  if (e.fg !== undefined) codes.push(sgrColor(e.fg, true, truecolor));
  if (e.bg !== undefined) codes.push(sgrColor(e.bg, false, truecolor));
  return `\x1b[${codes.join(";")}m`;
}

function sameStyle(a: PalEntry, b: PalEntry): boolean {
  return a === b || (a.fg === b.fg && a.bg === b.bg && (a.at ?? 0) === (b.at ?? 0));
}

/**
 * Turns a stream of frames into the smallest reasonable stream of ANSI writes.
 * Stateful: it remembers the last frame it emitted. The Go relay implements the
 * same algorithm for SSH sessions.
 */
export class FrameWriter {
  /** what the terminal is currently showing; the basis for the next diff */
  private shown: Grid | undefined;
  /** the last complete grid we know of; the source for `null` (unchanged) rows */
  private content: Grid | undefined;
  private truecolor: boolean;
  private lastTitle: string | undefined;

  constructor(opts: { truecolor?: boolean } = {}) {
    this.truecolor = opts.truecolor ?? true;
  }

  /**
   * Forget what is on screen, so the next frame is painted in full. Content is
   * deliberately kept: a repaint still needs somewhere to read unchanged rows
   * from.
   */
  invalidate(): void {
    this.shown = undefined;
  }

  /**
   * True when the sender must include every row, because we have nothing to
   * fill the gaps with: first frame, or a size we have never drawn.
   */
  needsFull(cols?: number, rows?: number): boolean {
    if (!this.content) return true;
    if (cols === undefined || rows === undefined) return false;
    return this.content.w !== cols || this.content.h !== rows;
  }

  update(f: Frame): string {
    const g = expand(f, this.content);
    const full = !this.shown || this.shown.w !== g.w || this.shown.h !== g.h;
    let out = "";
    if (full) out += "\x1b[2J";

    let cx = -1;
    let cy = -1;
    let cur: PalEntry | undefined;

    for (let y = 0; y < g.h; y++) {
      let x = 0;
      while (x < g.w) {
        const i = y * g.w + x;
        const c = g.ch[i]!;
        if (c === "") {
          x++;
          continue;
        }
        if (!full && this.shown) {
          const pi = y * g.w + x;
          if (this.shown.ch[pi] === c && sameStyle(this.shown.st[pi]!, g.st[i]!)) {
            x++;
            continue;
          }
        }
        // Emit a run of changed cells, tolerating short unchanged gaps rather
        // than paying for a cursor move every few columns.
        let end = x;
        let gap = 0;
        for (let xx = x; xx < g.w; xx++) {
          const ii = y * g.w + xx;
          const same =
            !full &&
            this.shown !== undefined &&
            this.shown.ch[ii] === g.ch[ii] &&
            sameStyle(this.shown.st[ii]!, g.st[ii]!);
          if (same) {
            if (++gap > 4) break;
          } else {
            gap = 0;
            end = xx;
          }
        }

        if (cy !== y || cx !== x) out += `\x1b[${y + 1};${x + 1}H`;
        for (let xx = x; xx <= end; xx++) {
          const ii = y * g.w + xx;
          const cc = g.ch[ii]!;
          if (cc === "") continue;
          const st = g.st[ii]!;
          if (!cur || !sameStyle(cur, st)) {
            out += sgr(st, this.truecolor);
            cur = st;
          }
          out += cc;
        }
        cx = end + 1;
        cy = y;
        x = end + 1;
      }
    }

    if (cur) out += "\x1b[0m";

    if (f.title && f.title !== this.lastTitle) {
      out += `\x1b]0;${f.title}\x07`;
      this.lastTitle = f.title;
    }
    if (f.bell) out += "\x07";

    out += f.cursor ? `\x1b[${f.cursor[1] + 1};${f.cursor[0] + 1}H\x1b[?25h` : "\x1b[?25l";

    this.shown = g;
    this.content = g;
    return out;
  }
}

export const ENTER_TUI = "\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H";
export const EXIT_TUI = "\x1b[?25h\x1b[?1049l";
