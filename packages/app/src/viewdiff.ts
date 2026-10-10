import type { Frame, Run } from "@lithe/core";

/**
 * Row-level diffing for stateless origins.
 *
 * The function that renders a frame has no memory of the previous one, so we
 * carry a 32-bit hash per row in a small opaque blob. Rows whose hash is
 * unchanged are sent as `null`, and the relay (which does hold the last frame)
 * fills them in. A full 120x40 frame is ~1.7 kB of JSON; a cursor move is a
 * couple of rows.
 */
interface ViewState {
  w: number;
  h: number;
  r: number[];
}

function hashRow(runs: Run[]): number {
  // FNV-1a over the row's wire form. Cheap and good enough to spot a change.
  let h = 0x811c9dc5;
  const s = JSON.stringify(runs);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Packed as raw bytes rather than JSON numbers: 4 bytes per row instead of
 * ~11, which matters because this blob rides along on every single keystroke.
 * Layout: u16 w | u16 h | u32 hash per row, base64'd.
 */
export function encodeViewState(v: ViewState): string {
  const buf = new ArrayBuffer(4 + v.r.length * 4);
  const dv = new DataView(buf);
  dv.setUint16(0, v.w);
  dv.setUint16(2, v.h);
  for (let i = 0; i < v.r.length; i++) dv.setUint32(4 + i * 4, v.r[i]!);
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function decodeViewState(blob: string | undefined): ViewState | undefined {
  if (!blob) return undefined;
  try {
    const bin = atob(blob);
    if (bin.length < 4 || (bin.length - 4) % 4 !== 0) return undefined;
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dv = new DataView(bytes.buffer);
    const r = new Array<number>((bin.length - 4) / 4);
    for (let i = 0; i < r.length; i++) r[i] = dv.getUint32(4 + i * 4);
    return { w: dv.getUint16(0), h: dv.getUint16(2), r };
  } catch {
    return undefined;
  }
}

export interface DiffResult {
  frame: Frame;
  vst: string;
  partial: boolean;
}

/** Replace unchanged rows with null and return the state to echo back. */
export function diffFrame(frame: Frame, prev: ViewState | undefined, full: boolean): DiffResult {
  const hashes = frame.rows.map((r) => hashRow(r ?? []));
  const next: ViewState = { w: frame.w, h: frame.h, r: hashes };
  const usable = !full && prev && prev.w === frame.w && prev.h === frame.h && prev.r.length === hashes.length;

  if (!usable) {
    return { frame, vst: encodeViewState(next), partial: false };
  }

  let changed = 0;
  const rows: (Run[] | null)[] = frame.rows.map((r, i) => {
    if (prev!.r[i] === hashes[i]) return null;
    changed++;
    return r;
  });

  // Palette entries are small; keeping the whole palette avoids re-indexing.
  return {
    frame: { ...frame, rows },
    vst: encodeViewState(next),
    partial: changed < frame.rows.length,
  };
}
