import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = await readFile(fileURLToPath(new URL("../bridge/lithe-bridge.py", import.meta.url)), "utf8");

// The bridge is the one thing a stranger runs. It must stay trivially
// auditable: standard library only, nothing fetched, nothing executed.
test("the bridge imports only the python standard library", () => {
  const imports = [...source.matchAll(/^import (\w+)|^from (\w+)/gm)].map((m) => m[1] ?? m[2]);
  expect(new Set(imports)).toEqual(new Set(["base64", "os", "select", "socket", "ssl", "struct", "sys"]));
});

test("the bridge never fetches or executes anything", () => {
  // Check the code, not the prose: the docstring mentions pip to say it needs none.
  const code = source
    .replace(/"""[\s\S]*?"""/g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
  for (const forbidden of [/\beval\s*\(/, /\bexec\s*\(/, /\bsubprocess\b/, /\burllib\b/, /\bimport\s+pip\b/, /__import__/, /\bos\.system\b/, /\bpopen\b/i]) {
    expect(code).not.toMatch(forbidden);
  }
});

test("it verifies TLS by default and only skips it when asked", () => {
  expect(source).toContain("ssl.create_default_context()");
  expect(source).toContain('"--insecure" in flags');
});

test("it masks client frames, as RFC 6455 requires", () => {
  expect(source).toContain("mask = os.urandom(4)");
  expect(source).toContain("0x80 | n");
});

test("it guards against the TLS buffering deadlock", () => {
  expect(source).toContain("frame_waiting");
  expect(source).toContain('pending = getattr(self.sock, "pending", None)');
});
