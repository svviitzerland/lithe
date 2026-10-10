#!/usr/bin/env bun
import { Runtime, type AppDef, type ClientCtx } from "@lithe/app";
import { drive } from "./driver.ts";
import { RemoteRuntime } from "./remote.ts";
import { scaffold } from "./init.ts";
import { pipeToWebSocket, sshArgs } from "./pipe.ts";
import { setup } from "./setup.ts";

const USAGE = `lithe — write a TUI once, serve it over SSH from anywhere.

  lithe dev [file]              run the app in this terminal (in-process)
  lithe dev --remote <url>      run against a deployed endpoint, over the wire
  lithe serve [file] [--port N] serve the app over HTTP for a relay to call
  lithe init [dir]              scaffold a new app with Vercel + Workers config
  lithe ssh <host> [ssh args]   ssh into a deployed app with no relay in between
  lithe pipe <host>             the ProxyCommand half of 'lithe ssh'
  lithe setup [--write]         teach plain 'ssh' about lithe apps, once

Default file: ./app.ts
`;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function loadApp(file: string): Promise<AppDef<unknown>> {
  const path = file.startsWith("/") ? file : `${process.cwd()}/${file}`;
  const mod = (await import(path)) as { default?: AppDef<unknown>; app?: AppDef<unknown> };
  const app = mod.default ?? mod.app;
  if (!app || typeof app.view !== "function") {
    throw new Error(`${file} must default-export an app created with defineApp()`);
  }
  return app;
}

function positional(after: string): string | undefined {
  const rest = process.argv.slice(3).filter((a) => !a.startsWith("-"));
  const skip = ["--remote", "--port"].flatMap((f) => {
    const i = process.argv.indexOf(f);
    return i === -1 ? [] : [process.argv[i + 1]!];
  });
  void after;
  return rest.find((r) => !skip.includes(r));
}

const cmd = process.argv[2];

try {
  if (cmd === "dev") {
    const remote = arg("--remote");
    if (remote) {
      await drive(new RemoteRuntime(remote), { onExit: (c) => process.exit(c) });
    } else {
      const app = await loadApp(positional("dev") ?? "app.ts");
      const ctx: ClientCtx = {
        user: process.env.USER ?? "local",
        term: process.env.TERM ?? "xterm-256color",
        ip: "127.0.0.1",
        app: "local",
      };
      await drive(new Runtime(app, ctx, process.env), { onExit: (c) => process.exit(c) });
    }
  } else if (cmd === "serve") {
    const app = await loadApp(positional("serve") ?? "app.ts");
    const { createHandler } = await import("@lithe/app");
    const port = Number(arg("--port") ?? process.env.PORT ?? 8787);
    const handler = createHandler(app);
    Bun.serve({ port, fetch: handler });
    console.log(`lithe origin on http://127.0.0.1:${port}`);
    console.log(`point a relay at it:  cd relay && go run . --origin http://127.0.0.1:${port}`);
  } else if (cmd === "pipe") {
    const host = process.argv[3];
    if (!host) throw new Error("usage: lithe pipe <host>");
    const opts: Parameters<typeof pipeToWebSocket>[0] = { host };
    if (process.argv.includes("--insecure")) opts.insecure = true;
    const p = arg("--port");
    if (p) opts.port = Number(p);
    const path = arg("--path");
    if (path) opts.path = path;
    process.exit(await pipeToWebSocket(opts));
  } else if (cmd === "ssh") {
    const host = process.argv[3];
    if (!host) throw new Error("usage: lithe ssh <host> [ssh args]");
    const self = process.argv[1] ? `${process.execPath} ${process.argv[1]}` : "lithe";
    const wsPort = arg("--ws-port");
    const wsPath = arg("--ws-path");
    // Everything we consume ourselves is stripped; the rest is passed to ssh.
    const consumed = new Set(["--insecure", "--ws-port", wsPort, "--ws-path", wsPath]);
    const extra = process.argv.slice(4).filter((a) => !consumed.has(a));
    const args = sshArgs(host, self, extra, {
      insecure: process.argv.includes("--insecure"),
      ...(wsPort ? { wsPort: Number(wsPort) } : {}),
      ...(wsPath ? { path: wsPath } : {}),
    });
    const proc = Bun.spawn(["ssh", ...args], { stdio: ["inherit", "inherit", "inherit"] });
    process.exit(await proc.exited);
  } else if (cmd === "setup") {
    const self = process.argv[1]?.endsWith(".ts")
      ? `${process.execPath} ${process.argv[1]}`
      : "lithe";
    const hostArg = arg("--host");
    await setup({
      proxyCommand: self,
      write: process.argv.includes("--write"),
      ...(hostArg ? { hosts: [hostArg] } : {}),
      ...(arg("--path") ? { path: arg("--path")! } : {}),
    });
  } else if (cmd === "init") {
    await scaffold(process.argv[3] ?? ".");
  } else {
    process.stdout.write(USAGE);
    process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  process.stderr.write(`lithe: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
