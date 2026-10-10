import { stat } from "node:fs/promises";
import { join } from "node:path";
import { ensureSeed, fingerprintOf } from "./hostkey.ts";

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function run(cmd: string[], opts: { input?: string; quiet?: boolean } = {}): Promise<number> {
  const proc = Bun.spawn(cmd, {
    stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : "inherit",
    stdout: opts.quiet ? "pipe" : "inherit",
    stderr: opts.quiet ? "pipe" : "inherit",
  });
  return proc.exited;
}

async function capture(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

export interface DeployOptions {
  cwd?: string;
  target?: "cloudflare" | "vercel";
  dryRun?: boolean;
  /** replace a host key the platform already holds with the local one */
  rotate?: boolean;
}

/**
 * Deploys, and provisions the host key on the way so nobody has to.
 *
 * The seed is generated once, kept in `.lithe/hostkey`, and pushed to the
 * platform's secret store. There is no `.env` to write and no value to copy
 * around — and because the same seed is reused, the SSH fingerprint stays put
 * across deploys and across platforms.
 */
export async function deploy(opts: DeployOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const hasWrangler = await exists(join(cwd, "wrangler.toml")) || await exists(join(cwd, "wrangler.jsonc"));
  const hasVercel = await exists(join(cwd, "vercel.json")) || await exists(join(cwd, "api"));
  const target = opts.target ?? (hasWrangler ? "cloudflare" : hasVercel ? "vercel" : undefined);

  if (!target) {
    process.stderr.write("lithe: no wrangler.toml or vercel.json here — run this in your app directory\n");
    return 1;
  }

  const { seed, created, path } = await ensureSeed(cwd);
  const localFingerprint = await fingerprintOf(seed);
  process.stdout.write(
    created ? `generated a host key, saved to ${path}\n` : `found a host key in ${path}\n`,
  );

  if (opts.dryRun) {
    process.stdout.write(`  ${localFingerprint}\n\nwould deploy to ${target}\n`);
    return 0;
  }

  const platform =
    target === "cloudflare"
      ? { list: ["bunx", "wrangler", "secret", "list"], set: ["bunx", "wrangler", "secret", "put", "LITHE_SSH_SEED"], ship: ["bunx", "wrangler", "deploy"], what: "Cloudflare secret" }
      : { list: ["bunx", "vercel", "env", "ls", "production"], set: ["bunx", "vercel", "env", "add", "LITHE_SSH_SEED", "production"], ship: ["bunx", "vercel", "deploy", "--prod", "--yes"], what: "Vercel environment variable" };

  const existing = await capture(platform.list);
  const alreadySet = existing.includes("LITHE_SSH_SEED");

  // The platform's copy is the one that matters. Never claim a fingerprint we
  // did not install: if a key is already there, we cannot read it back.
  let authoritative = true;
  if (alreadySet && !opts.rotate) {
    authoritative = false;
    process.stdout.write(
      `the ${platform.what} LITHE_SSH_SEED is already set — leaving it alone\n` +
        `  the live fingerprint is whatever that secret derives to, which may not be\n` +
        `  the one in ${path}. Pass --rotate to replace it (clients will see a\n` +
        `  host-key warning once).\n`,
    );
  } else {
    process.stdout.write(`installing the host key as a ${platform.what}…\n`);
    const code = await run(platform.set, { input: seed, quiet: true });
    if (code !== 0) {
      process.stderr.write(`lithe: could not set the secret — is the CLI logged in?\n`);
      return code;
    }
  }

  const code = await run(platform.ship);
  if (code === 0 && authoritative) process.stdout.write(`\nhost key ${localFingerprint}\n`);
  return code;
}
