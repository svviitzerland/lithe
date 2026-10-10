import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSeed, fingerprintOf } from "../src/hostkey.ts";
import { configBlock } from "../src/setup.ts";

test("a host key is generated on first use and reused after", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lithe-"));
  const first = await ensureSeed(dir);
  expect(first.created).toBe(true);
  expect(first.seed).toMatch(/^[0-9a-f]{64}$/);

  const second = await ensureSeed(dir);
  expect(second.created).toBe(false);
  expect(second.seed).toBe(first.seed);

  // Stability is the whole point: the same seed must give the same fingerprint.
  expect(await fingerprintOf(first.seed)).toBe(await fingerprintOf(second.seed));
});

test("two projects get different host keys", async () => {
  const a = await ensureSeed(await mkdtemp(join(tmpdir(), "lithe-a-")));
  const b = await ensureSeed(await mkdtemp(join(tmpdir(), "lithe-b-")));
  expect(a.seed).not.toBe(b.seed);
  expect(await fingerprintOf(a.seed)).not.toBe(await fingerprintOf(b.seed));
});

test("the key is not world-readable and not committable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lithe-"));
  const { path } = await ensureSeed(dir);
  const mode = (await stat(path)).mode & 0o777;
  expect(mode).toBe(0o600);
  expect(await readFile(join(dir, ".lithe", ".gitignore"), "utf8")).toBe("*\n");
});

test("the ssh config block is scoped and reversible", () => {
  const block = configBlock(["*.vercel.app"], "python3 /home/me/.ssh/lithe-bridge.py %h");
  expect(block).toContain("Host *.vercel.app");
  expect(block).toContain("ProxyCommand python3 /home/me/.ssh/lithe-bridge.py %h");
  expect(block).toContain("# >>> lithe >>>");
  expect(block).toContain("# <<< lithe <<<");
  // It must not touch anything beyond the hosts it names.
  expect(block).not.toContain("Host *\n");
});
