import { expect, test } from "bun:test";
import { decodeSession, encodeSession, MAX_SESSION_BYTES } from "../src/session.ts";

test("state survives a round trip", async () => {
  const state = { cursor: 3, items: ["a", "b"], nested: { ok: true } };
  const blob = await encodeSession(state, "secret");
  expect(await decodeSession<typeof state>(blob, "secret")).toEqual(state);
});

test("large state is gzipped", async () => {
  const big = { blob: "x".repeat(20_000) };
  const packed = await encodeSession(big, "secret");
  expect(packed.length).toBeLessThan(1000); // compressible, so it must have been
  expect(await decodeSession<typeof big>(packed, "secret")).toEqual(big);
});

test("state over the cap fails loudly rather than silently truncating", async () => {
  // Random bytes do not compress, so this genuinely exceeds the limit.
  const bytes = crypto.getRandomValues(new Uint8Array(80_000));
  const noise = btoa(String.fromCharCode(...bytes.subarray(0, 40_000))) + btoa(String.fromCharCode(...bytes.subarray(40_000)));
  await expect(encodeSession({ noise }, "s")).rejects.toThrow(/over the \d+ limit/);
  expect(MAX_SESSION_BYTES).toBe(65536);
});

test("a tampered blob is rejected, not trusted", async () => {
  const blob = await encodeSession({ admin: false }, "secret");
  const tampered = `${blob.slice(0, -4)}AAAA`;
  expect(await decodeSession(tampered, "secret")).toBeUndefined();
});

test("a blob signed with another secret is rejected", async () => {
  const blob = await encodeSession({ x: 1 }, "secret-a");
  expect(await decodeSession(blob, "secret-b")).toBeUndefined();
});

test("an unsigned blob is rejected when a secret is configured", async () => {
  const blob = await encodeSession({ x: 1 });
  expect(await decodeSession(blob, "secret")).toBeUndefined();
  expect(await decodeSession<{ x: number }>(blob)).toEqual({ x: 1 });
});

test("garbage decodes to undefined instead of throwing", async () => {
  expect(await decodeSession("not-base64-!!!", "s")).toBeUndefined();
  expect(await decodeSession("", "s")).toBeUndefined();
});
