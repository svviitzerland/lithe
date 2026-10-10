import type { Align, BoxNode, Child, CursorNode, DynNode, Justify, Node, Pad, Size, SpacerNode, TextNode } from "./layout.ts";
import type { BorderName } from "./screen.ts";
import type { Color, Style } from "./style.ts";
import { strWidth, truncate } from "./width.ts";

export interface TextOpts extends Style {
  wrap?: boolean;
  ellipsis?: string;
  align?: Align;
  w?: number | "fill";
  h?: number | "fill";
  grow?: number;
}

/** A run of text. Styling props are inline: `text("hi", { bold: true, fg: "cyan" })`. */
export function text(s: string | number, opts: TextOpts = {}): TextNode {
  const { wrap, align, w, h, grow, ellipsis, ...style } = opts;
  const n: TextNode = { k: "text", s: String(s) };
  if (Object.keys(style).length > 0) n.style = style as Style;
  if (wrap !== undefined) n.wrap = wrap;
  if (ellipsis !== undefined) n.ellipsis = ellipsis;
  if (align !== undefined) n.align = align;
  if (w !== undefined) n.w = w;
  if (h !== undefined) n.h = h;
  if (grow !== undefined) n.grow = grow;
  return n;
}

export interface BoxOpts {
  dir?: "col" | "row";
  gap?: number;
  pad?: Pad;
  border?: BorderName;
  borderStyle?: Style;
  borderColor?: Color;
  title?: string;
  bg?: Color;
  align?: Align;
  justify?: Justify;
  w?: number | "fill";
  h?: number | "fill";
  grow?: number;
}

function mkBox(dir: "col" | "row", a: BoxOpts | Child[], b?: Child[]): BoxNode {
  const opts: BoxOpts = Array.isArray(a) ? {} : a;
  const children: Child[] = Array.isArray(a) ? a : (b ?? []);
  const n: BoxNode = { k: "box", dir: opts.dir ?? dir, children };
  if (opts.gap !== undefined) n.gap = opts.gap;
  if (opts.pad !== undefined) n.pad = opts.pad;
  if (opts.border !== undefined) n.border = opts.border;
  if (opts.borderStyle || opts.borderColor) {
    n.borderStyle = { ...opts.borderStyle, ...(opts.borderColor ? { fg: opts.borderColor } : {}) };
  }
  if (opts.title !== undefined) n.title = opts.title;
  if (opts.bg !== undefined) n.bg = opts.bg;
  if (opts.align !== undefined) n.align = opts.align;
  if (opts.justify !== undefined) n.justify = opts.justify;
  if (opts.w !== undefined) n.w = opts.w;
  if (opts.h !== undefined) n.h = opts.h;
  if (opts.grow !== undefined) n.grow = opts.grow;
  return n;
}

/** Vertical container (the default). `box(children)` or `box(opts, children)`. */
export function box(a: BoxOpts | Child[], b?: Child[]): BoxNode {
  return mkBox("col", a, b);
}
/** Horizontal container. */
export function row(a: BoxOpts | Child[], b?: Child[]): BoxNode {
  return mkBox("row", a, b);
}
/** Vertical container, explicit alias of `box`. */
export const col = box;

/** Build part of the tree at layout time, once the real rect is known. */
export function dyn(fn: (size: Size) => Child, opts: { grow?: number; w?: number | "fill"; h?: number | "fill" } = {}): DynNode {
  return { k: "dyn", fn, ...opts };
}

/** Park the terminal cursor here. Used by `input`, useful for custom editors. */
export function cursorHere(): CursorNode {
  return { k: "cursor" };
}

/** Flexible blank space. Put one between two things to push them apart. */
export function spacer(grow = 1): SpacerNode {
  return { k: "spacer", grow };
}

export interface ListOpts {
  /** rendered before the selected row (default "› ") */
  cursor?: string;
  selectedStyle?: Style;
  itemStyle?: Style;
  /** visible window height; the list scrolls to keep the selection in view */
  height?: number;
  numbered?: boolean;
}

/**
 * A single-selection list that scrolls its own window. With no `height` it
 * measures the space it was actually given, so the selection never scrolls out
 * of view just because the layout got tight.
 */
export function list(items: string[], selected = 0, opts: ListOpts = {}): Node {
  if (opts.height === undefined) {
    return dyn(({ h }) => renderList(items, selected, { ...opts, height: Math.max(1, h) }), { grow: 1 });
  }
  return renderList(items, selected, opts);
}

function renderList(items: string[], selected: number, opts: ListOpts): Node {
  const marker = opts.cursor ?? "› ";
  const pad = " ".repeat(strWidth(marker));
  const h = Math.min(opts.height ?? items.length, items.length);
  const sel = Math.max(0, Math.min(selected, items.length - 1));
  // Keep the selection inside the window, biased to show context above.
  let start = 0;
  if (h < items.length) {
    start = Math.max(0, Math.min(sel - Math.floor(h / 2), items.length - h));
  }
  const slice = items.slice(start, start + h);
  return box(
    slice.map((it, i) => {
      const idx = start + i;
      const on = idx === sel;
      const label = opts.numbered ? `${idx + 1}. ${it}` : it;
      return text((on ? marker : pad) + label, {
        ...(on ? (opts.selectedStyle ?? { fg: "cyan", bold: true }) : (opts.itemStyle ?? {})),
        wrap: false,
      });
    }),
  );
}

export interface ProgressOpts {
  width?: number;
  filled?: string;
  empty?: string;
  style?: Style;
  emptyStyle?: Style;
  /** append "42%" after the bar */
  showPercent?: boolean;
}

/** A horizontal progress bar. `ratio` is 0..1. */
export function progress(ratio: number, opts: ProgressOpts = {}): Node {
  const w = opts.width ?? 20;
  const r = Math.max(0, Math.min(1, ratio));
  const on = Math.round(r * w);
  const parts: Child[] = [
    text((opts.filled ?? "█").repeat(on), { ...(opts.style ?? { fg: "cyan" }), wrap: false }),
    text((opts.empty ?? "░").repeat(w - on), { ...(opts.emptyStyle ?? { dim: true }), wrap: false }),
  ];
  if (opts.showPercent) parts.push(text(` ${Math.round(r * 100)}%`, { dim: true, wrap: false }));
  return row(parts);
}

export const SPINNERS = {
  dots: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  line: ["-", "\\", "|", "/"],
  bounce: ["⠁", "⠂", "⠄", "⠂"],
  pulse: ["●", "◐", "◓", "◑", "◒"],
} as const;

/** One frame of a spinner. Drive `tick` from your app's tick counter. */
export function spinner(tick: number, kind: keyof typeof SPINNERS = "dots", style?: Style): TextNode {
  const fr = SPINNERS[kind];
  return text(fr[Math.abs(tick) % fr.length]!, { ...style, wrap: false });
}

/** A horizontal divider that stretches to fill its parent. */
export function rule(style?: Style, char = "─"): Node {
  return dyn(({ w }) => text(char.repeat(Math.max(0, w)), { ...style, dim: style?.dim ?? true, wrap: false }), { w: "fill", h: 1 });
}

/** Aligned label/value pairs. */
export function kv(pairs: [string, string][], opts: { keyStyle?: Style; valStyle?: Style; gap?: number } = {}): Node {
  const kw = pairs.reduce((m, p) => Math.max(m, strWidth(p[0])), 0);
  return box(
    pairs.map(([k, v]) =>
      row({ gap: opts.gap ?? 1 }, [
        text(k.padEnd(kw), { ...(opts.keyStyle ?? { dim: true }), wrap: false }),
        text(v, { ...(opts.valStyle ?? {}), wrap: false }),
      ]),
    ),
  );
}

export interface TableOpts {
  head?: string[];
  widths?: number[];
  gap?: number;
  headStyle?: Style;
  rowStyle?: (i: number) => Style | undefined;
  selected?: number;
  selectedStyle?: Style;
}

/** A fixed-column table. Columns size to content unless `widths` is given. */
export function table(rows: string[][], opts: TableOpts = {}): Node {
  const cols = Math.max(opts.head?.length ?? 0, ...rows.map((r) => r.length));
  const widths =
    opts.widths ??
    Array.from({ length: cols }, (_, c) =>
      Math.max(
        strWidth(opts.head?.[c] ?? ""),
        ...rows.map((r) => strWidth(r[c] ?? "")),
      ),
    );
  const gap = opts.gap ?? 2;
  const line = (cs: string[], style?: Style) =>
    row(
      { gap },
      cs.map((c, i) =>
        text(truncate(c, widths[i] ?? 0).padEnd(widths[i] ?? 0), { ...style, wrap: false }),
      ),
    );
  const out: Child[] = [];
  if (opts.head) out.push(line(opts.head, opts.headStyle ?? { bold: true, underline: true }));
  rows.forEach((r, i) => {
    const style =
      opts.selected === i
        ? (opts.selectedStyle ?? { fg: "cyan", bold: true })
        : opts.rowStyle?.(i);
    out.push(line(r, style));
  });
  return box(out);
}

export interface InputOpts {
  label?: string;
  placeholder?: string;
  width?: number;
  focused?: boolean;
  mask?: boolean;
  style?: Style;
}

/**
 * A single-line text field. It renders the value and reports where the terminal
 * cursor should sit; `cursorAt` is consumed by the app runtime.
 */
export function input(value: string, cursor: number, opts: InputOpts = {}): Node {
  const w = opts.width ?? 24;
  const shown = opts.mask ? "\u2022".repeat(value.length) : value;
  const caret = Math.max(0, Math.min(cursor, shown.length));
  // Scroll the window so the caret is always inside the field.
  const off = Math.max(0, strWidth(shown.slice(0, caret)) - w + 1);
  const visible = shown.slice(off, off + w);
  const before = visible.slice(0, caret - off);
  const after = visible.slice(caret - off);
  const empty = value.length === 0 && !!opts.placeholder;

  const fieldStyle: Style = {
    ...(empty ? { dim: true } : (opts.style ?? {})),
    ...(opts.focused ? { bg: 236 } : { underline: true }),
  };

  const field: Child[] = empty
    ? [text(opts.placeholder!.slice(0, w).padEnd(w), { ...fieldStyle, dim: true, wrap: false })]
    : [
        text(before, { ...fieldStyle, wrap: false }),
        ...(opts.focused ? [cursorHere()] : []),
        text(after.padEnd(w - strWidth(before)), { ...fieldStyle, wrap: false }),
      ];

  const parts: Child[] = [];
  if (opts.label) parts.push(text(opts.label, { dim: true, wrap: false }));
  parts.push(row({ w: w + (opts.label ? 0 : 0) }, field));
  return row({ gap: 1 }, parts);
}
