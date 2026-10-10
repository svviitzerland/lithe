import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const BEGIN = "# >>> lithe >>>";
const END = "# <<< lithe <<<";

/** Platform hostnames where a lithe app is reachable over HTTPS. */
const DEFAULT_HOSTS = ["*.workers.dev", "*.vercel.app", "*.deno.dev", "*.netlify.app"];

export function configBlock(hosts: string[], proxyCommand: string): string {
  return [
    BEGIN,
    "# Lets plain `ssh <host>` reach a lithe app that is served over HTTPS.",
    "# The ssh session is end-to-end encrypted with the app itself; this only",
    "# carries bytes. Delete this block to undo.",
    "# https://github.com/svviitzerland/lithe",
    `Host ${hosts.join(" ")}`,
    `  ProxyCommand ${proxyCommand} pipe %h`,
    "  StrictHostKeyChecking accept-new",
    END,
    "",
  ].join("\n");
}

export interface SetupOptions {
  hosts?: string[];
  write?: boolean;
  proxyCommand: string;
  path?: string;
}

/**
 * Installs one SSH config block, once, that makes `ssh <host>` work for every
 * lithe app. This is the only client-side setup in the relay-less path, and it
 * is not per app.
 */
export async function setup(opts: SetupOptions): Promise<void> {
  const file = opts.path ?? join(homedir(), ".ssh", "config");
  const hosts = opts.hosts?.length ? opts.hosts : DEFAULT_HOSTS;
  const block = configBlock(hosts, opts.proxyCommand);

  if (!opts.write) {
    process.stdout.write(
      `Add this to ${file} — once, for every lithe app:\n\n${block}\n` +
        `Then: ssh my-app.vercel.app\n\n` +
        `Or let me append it for you:  lithe setup --write\n`,
    );
    return;
  }

  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    /* no config yet */
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
