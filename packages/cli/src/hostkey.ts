import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deriveSeed, hostKeyFromSeed } from "@lithe/ssh";

const DIR = ".lithe";
const FILE = "hostkey";

/**
 * The host key seed, generated on first use and kept on disk.
 *
 * Nobody should have to invent a secret, paste it into a dashboard and keep it
 * safe just to have a stable SSH fingerprint. So the first deploy makes one,
 * stores it in `.lithe/hostkey` (git-ignored), and installs it as a platform
 * secret. Every deploy after that reuses it, which is what keeps clients from
 * seeing a host-key warning.
 */
export async function ensureSeed(cwd = process.cwd()): Promise<{ seed: string; created: boolean; path: string }> {
  const dir = join(cwd, DIR);
  const path = join(dir, FILE);
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length >= 32) return { seed: existing, created: false, path };
  } catch {
    /* first run */
  }
  const seed = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  await mkdir(dir, { recursive: true });
  await writeFile(path, `${seed}\n`, { mode: 0o600 });
  // Keep it out of git without making the user think about it.
  await writeFile(join(dir, ".gitignore"), "*\n", { mode: 0o644 }).catch(() => undefined);
  return { seed, created: true, path };
}

export async function fingerprintOf(seed: string, label = "lithe"): Promise<string> {
  return (await hostKeyFromSeed(await deriveSeed(seed, label))).fingerprint;
}
