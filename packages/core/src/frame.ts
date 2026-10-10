import type { Color } from "./style.ts";

/** A style as it travels on the wire. Interned into the frame palette. */
export interface PalEntry {
  fg?: Color;
  bg?: Color;
  at?: number;
}

/** A horizontal span of cells sharing one palette entry: [text, paletteIndex]. */
export type Run = [string, number];

/**
 * One rendered screen, in the most compact form that is still trivially parseable
 * from any language: a palette plus one array of runs per row.
 *
 * The relay (or local terminal driver) diffs consecutive frames and emits ANSI.
 * Apps never emit escape codes themselves.
 */
export interface Frame {
  /** columns */
  w: number;
  /** rows */
  h: number;
  /** palette; index 0 is always the terminal default style */
  pal: PalEntry[];
  /**
   * One entry per row. `null` means "unchanged since the last frame you drew",
   * which is how a stateless origin ships a partial update: it remembers only a
   * hash per row, not the pixels.
   */
  rows: (Run[] | null)[];
  /** visible cursor position [col, row], omitted to hide the cursor */
  cursor?: [number, number];
  /** terminal window title */
  title?: string;
  /** ring the bell once on this frame */
  bell?: boolean;
}
