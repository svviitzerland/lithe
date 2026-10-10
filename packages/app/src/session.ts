/**
 * Session blobs: the app's whole state, round-tripped through the relay so the
 * serverless function itself can stay stateless and die between keystrokes.
 *
 * Layout: base64url( flags[1] | mac[16]? | payload )
 *   flags bit0 = payload is gzipped, bit1 = mac present
 */

const FLAG_GZIP = 1;
const FLAG_MAC = 2;
const GZIP_THRESHOLD = 1024;
const MAC_LEN = 16;

export const MAX_SESSION_BYTES = 64 * 1024;

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    keyCache.set(secret, k);
  }
  return k;
}

async function mac(secret: string, data: Uint8Array): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), data as BufferSource);
  return new Uint8Array(sig).slice(0, MAC_LEN);
}

function b64urlEncode(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function through(data: Uint8Array, kind: "gzip" | "gunzip"): Promise<Uint8Array<ArrayBuffer>> {
  const stream =
    kind === "gzip" ? new CompressionStream("gzip") : new DecompressionStream("gzip");
  const w = stream.writable.getWriter();
  void w.write(data as BufferSource).then(() => w.close());
  const buf = (await new Response(stream.readable).arrayBuffer()) as ArrayBuffer;
  return new Uint8Array(buf);
}

export async function encodeSession(state: unknown, secret?: string): Promise<string> {
  let payload = new TextEncoder().encode(JSON.stringify(state ?? null));
  let flags = 0;
  if (payload.byteLength > GZIP_THRESHOLD) {
    const gz = await through(payload, "gzip");
    if (gz.byteLength < payload.byteLength) {
      payload = gz;
      flags |= FLAG_GZIP;
    }
  }
  if (secret) flags |= FLAG_MAC;

  const head = new Uint8Array([flags]);
  const signed = secret ? await mac(secret, concat(head, payload)) : undefined;
  const out = signed ? concat(head, signed, payload) : concat(head, payload);
  if (out.byteLength > MAX_SESSION_BYTES) {
    throw new Error(
      `lithe: session state is ${out.byteLength} bytes, over the ${MAX_SESSION_BYTES} limit. ` +
        `Keep large data in a store (KV/R2/Redis) and hold only a handle in state.`,
    );
  }
  return b64urlEncode(out);
}

/** Returns undefined for anything we cannot trust or parse, so callers re-init. */
export async function decodeSession<S>(blob: string, secret?: string): Promise<S | undefined> {
  try {
    const raw = b64urlDecode(blob);
    const flags = raw[0] ?? 0;
    const hasMac = (flags & FLAG_MAC) !== 0;
    const payload = raw.slice(1 + (hasMac ? MAC_LEN : 0));
    if (secret) {
      if (!hasMac) return undefined;
      const expect = await mac(secret, concat(new Uint8Array([flags]), payload));
      const got = raw.slice(1, 1 + MAC_LEN);
      if (!timingSafeEqual(expect, got)) return undefined;
    }
    const bytes = flags & FLAG_GZIP ? await through(payload, "gunzip") : payload;
    return JSON.parse(new TextDecoder().decode(bytes)) as S;
  } catch {
    return undefined;
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
