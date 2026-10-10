import { BORDERS, Screen, wrap, type BorderName } from "./screen.ts";
import type { Color, Style } from "./style.ts";
import { strWidth, truncate } from "./width.ts";

export type Align = "start" | "center" | "end" | "fill";
export type Justify = "start" | "center" | "end" | "between";
/** padding: all | [vertical, horizontal] | [top, right, bottom, left] */
export type Pad = number | [number, number] | [number, number, number, number];

interface Common {
  /** share of leftover space along the parent's main axis */
  grow?: number;
  /** fixed size, or "fill" to take everything the parent offers */
  w?: number | "fill";
  h?: number | "fill";
}

export interface TextNode extends Common {
  k: "text";
  s: string;
  style?: Style;
  /** wrap long lines instead of truncating (default true) */
  wrap?: boolean;
  align?: Align;
  /** marker appended when a non-wrapping line is cut (default "…") */
  ellipsis?: string;
}

export interface BoxNode extends Common {
  k: "box";
  children: Child[];
  dir: "col" | "row";
  gap?: number;
  pad?: Pad;
  border?: BorderName;
  borderStyle?: Style;
  title?: string;
  bg?: Color;
  /** cross-axis placement of children (default "fill") */
  align?: Align;
  /** main-axis placement when there is leftover space (default "start") */
  justify?: Justify;
}

export interface SpacerNode extends Common {
  k: "spacer";
}

/**
 * Defers part of the tree until layout time, when the real rect is known.
 * Lets widgets be responsive without the author threading sizes around.
 * `fn` must be pure: it is called once to measure and once to render.
 */
export interface DynNode extends Common {
  k: "dyn";
  fn: (size: Size) => Child;
}

/** Zero-width marker: parks the terminal's own cursor wherever it lands. */
export interface CursorNode extends Common {
  k: "cursor";
}

export type Node = TextNode | BoxNode | SpacerNode | DynNode | CursorNode;
/** Falsy children are dropped, so `cond && text("hi")` just works. */
export type Child = Node | null | undefined | false | "";

export interface Size {
  w: number;
  h: number;
}

function kids(n: BoxNode): Node[] {
  return n.children.filter((c): c is Node => !!c);
}

function pads(p: Pad | undefined): [number, number, number, number] {
  if (p === undefined) return [0, 0, 0, 0];
  if (typeof p === "number") return [p, p, p, p];
  if (p.length === 2) return [p[0], p[1], p[0], p[1]];
  return p;
}

function frameOf(n: BoxNode): { t: number; r: number; b: number; l: number } {
  const [pt, pr, pb, pl] = pads(n.pad);
  const b = n.border && n.border !== "none" ? 1 : 0;
  return { t: pt + b, r: pr + b, b: pb + b, l: pl + b };
}

function growOf(n: Node): number {
  return n.grow ?? (n.k === "spacer" ? 1 : 0);
}

function lines(n: TextNode, availW: number): string[] {
  const raw = n.s.split("\n");
  if (n.wrap === false) return raw.map((l) => truncate(l, availW, n.ellipsis ?? "…"));
  return raw.flatMap((l) => (strWidth(l) <= availW ? [l] : wrap(l, availW)));
}

/** Intrinsic size of a node given the space the parent can offer. */
export function measure(n: Node, availW: number, availH: number): Size {
  let w: number;
  let h: number;

  if (n.k === "spacer" || n.k === "cursor") {
    w = 0;
    h = 0;
  } else if (n.k === "dyn") {
    const inner = n.fn({ w: availW, h: availH });
    const s = inner ? measure(inner, availW, availH) : { w: 0, h: 0 };
    w = s.w;
    h = s.h;
  } else if (n.k === "text") {
    const budget = typeof n.w === "number" ? n.w : availW;
    const ls = lines(n, Math.max(0, budget));
    w = ls.reduce((m, l) => Math.max(m, strWidth(l)), 0);
    h = ls.length;
  } else {
    const f = frameOf(n);
    const innerW = Math.max(0, (typeof n.w === "number" ? n.w : availW) - f.l - f.r);
    const innerH = Math.max(0, (typeof n.h === "number" ? n.h : availH) - f.t - f.b);
    const cs = kids(n);
    const gap = (n.gap ?? 0) * Math.max(0, cs.length - 1);
    let mainW = 0;
    let mainH = 0;
    for (const c of cs) {
      const s = measure(c, innerW, innerH);
      if (n.dir === "col") {
        mainW = Math.max(mainW, s.w);
        mainH += s.h;
      } else {
        mainW += s.w;
        mainH = Math.max(mainH, s.h);
      }
    }
    if (n.dir === "col") mainH += gap;
    else mainW += gap;
    w = mainW + f.l + f.r;
    h = mainH + f.t + f.b;
  }

  if (typeof n.w === "number") w = n.w;
  else if (n.w === "fill") w = availW;
  if (typeof n.h === "number") h = n.h;
  else if (n.h === "fill") h = availH;

  return { w: Math.min(w, availW), h: Math.min(h, availH) };
}

/** Lay a node out into `rect` on `screen`. */
export function render(n: Node, sc: Screen, x: number, y: number, w: number, h: number): void {
  if (n.k === "cursor") {
    sc.cursor = [x, y];
    return;
  }
  if (w <= 0 || h <= 0) return;

  if (n.k === "spacer") return;

  if (n.k === "dyn") {
    const inner = n.fn({ w, h });
    if (inner) render(inner, sc, x, y, w, h);
    return;
  }

  if (n.k === "text") {
    const ls = lines(n, w).slice(0, h);
    for (let i = 0; i < ls.length; i++) {
      const line = ls[i]!;
      const lw = strWidth(line);
      const off =
        n.align === "center" ? Math.floor((w - lw) / 2) : n.align === "end" ? w - lw : 0;
      sc.text(x + Math.max(0, off), y + i, line, n.style, w - Math.max(0, off));
    }
    return;
  }

  if (n.bg) sc.fill(x, y, w, h, " ", { bg: n.bg });
  if (n.border && n.border !== "none") {
    sc.border(x, y, w, h, BORDERS[n.border], n.borderStyle, n.title);
  } else if (n.title) {
    sc.text(x, y, truncate(n.title, w), n.borderStyle, w);
  }

  const f = frameOf(n);
  const ix = x + f.l;
  const iy = y + f.t;
  const iw = w - f.l - f.r;
  const ih = h - f.t - f.b;
  if (iw <= 0 || ih <= 0) return;

  const cs = kids(n);
  if (cs.length === 0) return;
  const gap = n.gap ?? 0;
  const mainAvail = (n.dir === "col" ? ih : iw) - gap * (cs.length - 1);
  const crossAvail = n.dir === "col" ? iw : ih;

  const sizes = cs.map((c) => measure(c, iw, ih));
  const mains = sizes.map((s) => (n.dir === "col" ? s.h : s.w));
  let used = mains.reduce((a, b) => a + b, 0);
  let free = Math.max(0, mainAvail - used);

  const grows = cs.map(growOf);
  const totalGrow = grows.reduce((a, b) => a + b, 0);
  if (totalGrow > 0 && free > 0) {
    let left = free;
    for (let i = 0; i < cs.length; i++) {
      const share = i === cs.length - 1 ? left : Math.floor((free * grows[i]!) / totalGrow);
      mains[i] = mains[i]! + share;
      left -= share;
    }
    used = mainAvail;
    free = 0;
  }

  // Overflow: trim from the end so the first children stay intact.
  if (used > mainAvail) {
    let over = used - mainAvail;
    for (let i = cs.length - 1; i >= 0 && over > 0; i--) {
      const take = Math.min(mains[i]!, over);
      mains[i] = mains[i]! - take;
      over -= take;
    }
  }

  const justify = n.justify ?? "start";
  let cursor = 0;
  let between = 0;
  if (free > 0) {
    if (justify === "center") cursor = Math.floor(free / 2);
    else if (justify === "end") cursor = free;
    else if (justify === "between" && cs.length > 1) between = Math.floor(free / (cs.length - 1));
  }

  const align = n.align ?? "fill";
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]!;
    const main = mains[i]!;
    const natCross = n.dir === "col" ? sizes[i]!.w : sizes[i]!.h;
    const fillCross = c.w === "fill" || c.h === "fill";
    const cross = align === "fill" || fillCross ? crossAvail : Math.min(natCross, crossAvail);
    const pad =
      align === "center"
        ? Math.floor((crossAvail - cross) / 2)
        : align === "end"
          ? crossAvail - cross
          : 0;

    if (n.dir === "col") render(c, sc, ix + pad, iy + cursor, cross, main);
    else render(c, sc, ix + cursor, iy + pad, main, cross);

    cursor += main + gap + between;
  }
}

/** Render a tree to a fresh screen of the given terminal size. */
export function renderToScreen(n: Node, cols: number, rows: number): Screen {
  const sc = new Screen(cols, rows);
  render(n, sc, 0, 0, sc.w, sc.h);
  return sc;
}
