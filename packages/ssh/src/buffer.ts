/**
 * The SSH wire types from RFC 4251 §5: byte, uint32, string (length-prefixed
 * bytes), mpint (big-endian signed integer) and name-list.
 */

export class Writer {
  private parts: Uint8Array[] = [];
  private len = 0;

  byte(n: number): this {
    return this.raw(new Uint8Array([n & 0xff]));
  }

  bool(b: boolean): this {
    return this.byte(b ? 1 : 0);
  }

  uint32(n: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0);
    return this.raw(b);
  }

  uint64(n: bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n);
    return this.raw(b);
  }

  /** length-prefixed bytes or UTF-8 text */
  string(s: Uint8Array | string): this {
    const b = typeof s === "string" ? new TextEncoder().encode(s) : s;
    return this.uint32(b.byteLength).raw(b);
  }

  nameList(names: string[]): this {
    return this.string(names.join(","));
  }

  /**
   * A signed big-endian integer. Leading zero bytes are stripped, and a 0x00 is
   * prepended when the top bit is set so the value stays positive. The shared
   * secret from key exchange is hashed in this form, so getting it wrong breaks
   * the exchange hash in a way that is hard to debug.
   */
  mpint(bytes: Uint8Array): this {
    let i = 0;
    while (i < bytes.length && bytes[i] === 0) i++;
    const v = bytes.subarray(i);
    if (v.length === 0) return this.uint32(0);
    if ((v[0]! & 0x80) !== 0) {
      const padded = new Uint8Array(v.length + 1);
      padded.set(v, 1);
      return this.string(padded);
    }
    return this.string(v);
  }

  raw(b: Uint8Array): this {
    this.parts.push(b);
    this.len += b.byteLength;
    return this;
  }

  get length(): number {
    return this.len;
  }

  done(): Uint8Array {
    const out = new Uint8Array(this.len);
    let off = 0;
    for (const p of this.parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    return out;
  }
}

export class Reader {
  private view: DataView;
  pos = 0;

  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get remaining(): number {
    return this.buf.byteLength - this.pos;
  }

  private need(n: number): void {
    if (this.remaining < n) throw new Error(`ssh: truncated packet (wanted ${n}, have ${this.remaining})`);
  }

  byte(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }

  bool(): boolean {
    return this.byte() !== 0;
  }

  uint32(): number {
    this.need(4);
    const n = this.view.getUint32(this.pos);
    this.pos += 4;
    return n;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  string(): Uint8Array {
    return this.bytes(this.uint32());
  }

  text(): string {
    return new TextDecoder().decode(this.string());
  }

  nameList(): string[] {
    const s = this.text();
    return s === "" ? [] : s.split(",");
  }

  rest(): Uint8Array {
    return this.bytes(this.remaining);
  }
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
