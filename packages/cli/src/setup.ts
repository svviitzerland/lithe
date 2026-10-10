import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BEGIN = "# >>> lithe >>>";
const END = "# <<< lithe <<<";

/** Platform hostnames where a lithe app is reachable over HTTPS. */
const DEFAULT_HOSTS = ["*.workers.dev", "*.vercel.app", "*.deno.dev", "*.netlify.app"];

/** The bridge ships with this package; it is never fetched at connect time. */
function bridgeSource(): string {
  return fileURLToPath(new URL("../bridge/lithe-bridge.py", import.meta.url));
}

export function configBlock(hosts: string[], proxyCommand: string): string {
  return [
    BEGIN,
    "# Lets plain `ssh <host>` reach a lithe app served over HTTPS.",
    "#",
    "# A serverless platform offers no raw TCP and buffers HTTP request bodies,",
    "# so a WebSocket is the only bidirectional channel — and that needs framing",
    "# no shell tool can do. This runs a small Python script instead, using only",
    "# the standard library. The ssh session is end-to-end encrypted with the",
    "# app; the script moves bytes and holds no keys.",
    "#",
    "# Delete this block to undo. https://github.com/svviitzerland/lithe",
    `Host ${hosts.join(" ")}`,
    `  ProxyCommand ${proxyCommand}`,
    "  StrictHostKeyChecking accept-new",
    END,
    "",
  ].join("\n");
}

export interface SetupOptions {
  hosts?: string[];
  write?: boolean;
  path?: string;
  /** where to install the bridge; defaults to ~/.ssh/lithe-bridge.py */
  bridgePath?: string;
}

/**
 * Installs one SSH config block, once, that makes `ssh <host>` work for every
 * lithe app. Not per app, and nothing to install: it needs `python3`, which is
 * already on every Mac and Linux.
 */
export async function setup(opts: SetupOptions = {}): Promise<void> {
  const sshDir = join(homedir(), ".ssh");
  const file = opts.path ?? join(sshDir, "config");
  const bridge = opts.bridgePath ?? join(sshDir, "lithe-bridge.py");
  const hosts = opts.hosts?.length ? opts.hosts : DEFAULT_HOSTS;
  const block = configBlock(hosts, `python3 ${bridge} %h`);

  if (!opts.write) {
    process.stdout.write(
      `Add this to ${file} — once, for every lithe app:\n\n${block}\n` +
        `It runs ${bridge}, which \`lithe setup --write\` installs for you.\n\n` +
        `Then: ssh my-app.vercel.app\n\n` +
        `Or let me do both:  lithe setup --write\n`,
    );
    return;
  }

  await mkdir(dirname(bridge), { recursive: true, mode: 0o700 }).catch(() => undefined);
  await copyFile(bridgeSource(), bridge);
  process.stdout.write(`installed the bridge at ${bridge}\n`);

  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    /* no config yet */
  }

  // Never edit someone's ssh config without leaving them a way back.
  if (existing) {
    const backup = `${file}.lithe-backup`;
    await copyFile(file, backup);
    process.stdout.write(`backed up ${file} to ${backup}\n`);
  }

  if (existing.includes(BEGIN)) {
    const start = existing.indexOf(BEGIN);
    const stop = existing.indexOf(END, start);
    const updated =
      stop === -1
        ? existing.slice(0, start) + block
        : existing.slice(0, start) + block + existing.slice(stop + END.length + 1);
    await writeFile(file, updated);
    process.stdout.write(`updated the lithe block in ${file}\n`);
    return;
  }

  // `Host` blocks run until the next Host line, so ours must come first to win.
  await writeFile(file, existing ? `${block}\n${existing}` : block, { mode: 0o600 });
  process.stdout.write(`added a lithe block to ${file}\n\n  ssh my-app.vercel.app\n`);
}
