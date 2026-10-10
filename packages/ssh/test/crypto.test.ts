import { expect, test } from "bun:test";
import { Reader } from "../src/buffer.ts";
import {
  GcmCipher,
  deriveSeed,
  hostKeyFromSeed,
  keyFingerprint,
  verifyClientSignature,
  x25519Ephemeral,
} from "../src/crypto.ts";

test("a host key is fully determined by its seed", async () => {
  const seed = await deriveSeed("my-secret", "lithe");
  const a = await hostKeyFromSeed(seed);
  const b = await hostKeyFromSeed(await deriveSeed("my-secret", "lithe"));
  const other = await hostKeyFromSeed(await deriveSeed("my-secret", "different-label"));
  expect(a.fingerprint).toBe(b.fingerprint);
  expect(a.fingerprint).not.toBe(other.fingerprint);
  expect(a.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
});

test("the host key blob is a well-formed ssh-ed25519 key", async () => {
  const key = await hostKeyFromSeed(await deriveSeed("s", "l"));
  const r = new Reader(key.blob);
  expect(r.text()).toBe("ssh-ed25519");
  expect(r.string().byteLength).toBe(32);
  expect(await keyFingerprint(key.blob)).toBe(key.fingerprint);
});

test("host key signatures are wire-encoded and verify as ed25519", async () => {
  const key = await hostKeyFromSeed(await deriveSeed("s", "l"));
  const message = new TextEncoder().encode("exchange hash");
  const sigBlob = await key.sign(message);
  const sr = new Reader(sigBlob);
  expect(sr.text()).toBe("ssh-ed25519");
  const raw = sr.string();
  expect(raw.byteLength).toBe(64);
  expect(await verifyClientSignature("ssh-ed25519", key.blob, raw, message)).toBe(true);
  // A different message must not verify.
  expect(await verifyClientSignature("ssh-ed25519", key.blob, raw, new Uint8Array([1]))).toBe(false);
});

test("an unsupported signature algorithm fails closed", async () => {
  const key = await hostKeyFromSeed(await deriveSeed("s", "l"));
  expect(await verifyClientSignature("ssh-dss", key.blob, new Uint8Array(64), new Uint8Array(4))).toBe(false);
});

test("x25519 agreement produces the same secret on both sides", async () => {
  const a = await x25519Ephemeral();
  const b = await x25519Ephemeral();
  const sa = await a.derive(b.publicKey);
  const sb = await b.derive(a.publicKey);
  expect([...sa]).toEqual([...sb]);
  expect(sa.byteLength).toBe(32);
});

test("the gcm counter advances per packet, so order matters", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const send = await GcmCipher.create(key, iv);
  const recv = await GcmCipher.create(key, iv);
  const aad = new Uint8Array([0, 0, 0, 16]);

  const one = await send.seal(new Uint8Array(16).fill(1), aad);
  const two = await send.seal(new Uint8Array(16).fill(2), aad);

  expect([...(await recv.open(one, aad))]).toEqual([...new Uint8Array(16).fill(1)]);
  expect([...(await recv.open(two, aad))]).toEqual([...new Uint8Array(16).fill(2)]);

  // Replaying a packet out of order must not decrypt.
  const fresh = await GcmCipher.create(key, iv);
  await expect(fresh.open(two, aad)).rejects.toThrow();
});

test("tampering with the length field breaks authentication", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const send = await GcmCipher.create(key, iv);
  const recv = await GcmCipher.create(key, iv);
  const sealed = await send.seal(new Uint8Array(16), new Uint8Array([0, 0, 0, 16]));
  await expect(recv.open(sealed, new Uint8Array([0, 0, 0, 32]))).rejects.toThrow();
});
