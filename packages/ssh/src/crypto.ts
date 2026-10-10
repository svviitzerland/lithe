import { Writer, concat } from "./buffer.ts";

/**
 * Every primitive SSH-2 needs, taken from WebCrypto so this runs unchanged on
 * Workers, Vercel, Deno, Bun and Node.
 *
 * The suite is chosen to avoid bignum arithmetic entirely: curve25519-sha256 for
 * key exchange, ssh-ed25519 host keys, aes256-gcm@openssh.com for transport. No
 * Diffie-Hellman groups, no RSA key exchange, so there is nothing to implement
 * by hand.
 */

const subtle = crypto.subtle;

export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", concat(...parts) as BufferSource));
}

// --- X25519 -----------------------------------------------------------------

export interface Ephemeral {
  publicKey: Uint8Array;
  derive(peer: Uint8Array): Promise<Uint8Array>;
}

export async function x25519Ephemeral(): Promise<Ephemeral> {
  const kp = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
  return {
    publicKey,
    async derive(peer: Uint8Array): Promise<Uint8Array> {
      const pub = await subtle.importKey("raw", peer as BufferSource, { name: "X25519" }, false, []);
      return new Uint8Array(await subtle.deriveBits({ name: "X25519", public: pub }, kp.privateKey, 256));
    },
  };
}

// --- Ed25519 host keys ------------------------------------------------------

/** PKCS8 wrapper for a raw Ed25519 seed; WebCrypto has no raw private import. */
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export interface HostKey {
  /** SSH wire encoding: string "ssh-ed25519" || string pubkey */
  blob: Uint8Array;
  /** "SHA256:…", exactly what OpenSSH shows on first connect */
  fingerprint: string;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/**
 * Builds a host key from 32 bytes of seed. Deterministic, so the same seed means
 * the same fingerprint forever and there is no key file to store, rotate or leak.
 */
export async function hostKeyFromSeed(seed: Uint8Array): Promise<HostKey> {
  if (seed.byteLength !== 32) throw new Error("ssh: host key seed must be 32 bytes");
  const priv = await subtle.importKey(
    "pkcs8",
    concat(PKCS8_ED25519_PREFIX, seed) as BufferSource,
    { name: "Ed25519" },
    true,
    ["sign"],
  );
  const jwk = (await subtle.exportKey("jwk", priv)) as { x?: string };
  if (!jwk.x) throw new Error("ssh: could not derive the public key");
  const pub = b64urlToBytes(jwk.x);
  const blob = new Writer().string("ssh-ed25519").string(pub).done();
  const digest = await sha256(blob);
  return {
    blob,
    fingerprint: `SHA256:${bytesToB64(digest).replace(/=+$/, "")}`,
    async sign(data: Uint8Array): Promise<Uint8Array> {
      const raw = new Uint8Array(await subtle.sign({ name: "Ed25519" }, priv, data as BufferSource));
      // SSH signatures are themselves wire-encoded: string algo || string sig
      return new Writer().string("ssh-ed25519").string(raw).done();
    },
  };
}

/** Derives a stable seed from any secret string plus a label. */
export async function deriveSeed(secret: string, label: string): Promise<Uint8Array> {
  const key = await subtle.importKey(
    "raw",
    new TextEncoder().encode(secret) as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("lithe-hostkey-v1") as BufferSource,
      info: new TextEncoder().encode(label) as BufferSource,
    },
    key,
    256,
  );
  return new Uint8Array(bits);
}

// --- AES-GCM transport cipher ----------------------------------------------

/**
 * aes256-gcm@openssh.com. The 12-byte IV is fixed(4) || counter(8) and the
 * counter increments once per packet, independently in each direction.
 */
export class GcmCipher {
  private key: CryptoKey;
  private fixed: Uint8Array;
  private counter: bigint;

  private constructor(key: CryptoKey, iv: Uint8Array) {
    this.key = key;
    this.fixed = iv.subarray(0, 4);
    this.counter = new DataView(iv.buffer, iv.byteOffset + 4, 8).getBigUint64(0);
  }

  static async create(keyBytes: Uint8Array, iv: Uint8Array): Promise<GcmCipher> {
    const key = await subtle.importKey("raw", keyBytes as BufferSource, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
    return new GcmCipher(key, iv);
  }

  private nonce(): Uint8Array {
    const n = new Uint8Array(12);
    n.set(this.fixed, 0);
    new DataView(n.buffer).setBigUint64(4, this.counter);
    return n;
  }

  private bump(): void {
    this.counter = (this.counter + 1n) & 0xffffffffffffffffn;
  }

  async seal(plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    const iv = this.nonce();
    const out = new Uint8Array(
      await subtle.encrypt(
        { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
        this.key,
        plaintext as BufferSource,
      ),
    );
    this.bump();
    return out;
  }

  async open(ciphertextWithTag: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    const iv = this.nonce();
    const out = new Uint8Array(
      await subtle.decrypt(
        { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
        this.key,
        ciphertextWithTag as BufferSource,
      ),
    );
    this.bump();
    return out;
  }
}

// --- client public key verification (for publickey auth) --------------------

export const SUPPORTED_SIG_ALGS = [
  "ssh-ed25519",
  "rsa-sha2-256",
  "rsa-sha2-512",
  "ecdsa-sha2-nistp256",
];

function bytesToB64Url(b: Uint8Array): string {
  return bytesToB64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strips the leading sign byte an SSH mpint may carry. */
function unsigned(b: Uint8Array): Uint8Array {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.subarray(i);
}

/**
 * Verifies a client's authentication signature. Returns false for anything we
 * cannot check, rather than pretending it passed.
 */
export async function verifyClientSignature(
  algo: string,
  keyBlob: Uint8Array,
  signature: Uint8Array,
  signed: Uint8Array,
): Promise<boolean> {
  const { Reader } = await import("./buffer.ts");
  try {
    const kb = new Reader(keyBlob);
    const keyType = kb.text();

    if (algo === "ssh-ed25519" && keyType === "ssh-ed25519") {
      const pub = kb.string();
      const key = await subtle.importKey("raw", pub as BufferSource, { name: "Ed25519" }, false, ["verify"]);
      return await subtle.verify({ name: "Ed25519" }, key, signature as BufferSource, signed as BufferSource);
    }

    if ((algo === "rsa-sha2-256" || algo === "rsa-sha2-512") && keyType === "ssh-rsa") {
      const e = unsigned(kb.string());
      const n = unsigned(kb.string());
      const hash = algo === "rsa-sha2-256" ? "SHA-256" : "SHA-512";
      const key = await subtle.importKey(
        "jwk",
        { kty: "RSA", n: bytesToB64Url(n), e: bytesToB64Url(e), alg: hash === "SHA-256" ? "RS256" : "RS512", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash },
        false,
        ["verify"],
      );
      return await subtle.verify("RSASSA-PKCS1-v1_5", key, signature as BufferSource, signed as BufferSource);
    }

    if (algo === "ecdsa-sha2-nistp256" && keyType === "ecdsa-sha2-nistp256") {
      kb.string(); // curve name
      const point = kb.string(); // 0x04 || X || Y
      const key = await subtle.importKey(
        "raw",
        point as BufferSource,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      // SSH wraps ECDSA signatures as mpint r || mpint s; WebCrypto wants r||s raw.
      const sr = new Reader(signature);
      const r = unsigned(sr.string());
      const s = unsigned(sr.string());
      const raw = new Uint8Array(64);
      raw.set(r, 32 - r.length);
      raw.set(s, 64 - s.length);
      return await subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        raw as BufferSource,
        signed as BufferSource,
      );
    }

    return false;
  } catch {
    return false;
  }
}

/** The SHA256 fingerprint of a public key blob, in OpenSSH's display format. */
export async function keyFingerprint(blob: Uint8Array): Promise<string> {
  return `SHA256:${bytesToB64(await sha256(blob)).replace(/=+$/, "")}`;
}
