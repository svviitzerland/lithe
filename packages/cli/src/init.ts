import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const APP = `import { defineApp, box, row, text, list, spacer } from "@lithe/app";

interface State {
  cursor: number;
  items: string[];
  ticks: number;
}

export default defineApp<State>({
  name: "NAME",
  description: "An SSH app built with lithe.",

  init: () => ({ cursor: 0, items: ["Overview", "Status", "About"], ticks: 0 }),

  update(s, ev, io) {
    if (ev.t === "tick") s.ticks++;
    if (ev.t === "key") {
      if (ev.key === "q" || ev.key === "ctrl+c") return io.exit();
      if (ev.key === "up" || ev.key === "k") s.cursor = Math.max(0, s.cursor - 1);
      if (ev.key === "down" || ev.key === "j") s.cursor = Math.min(s.items.length - 1, s.cursor + 1);
    }
    io.wake(1000); // keep the clock ticking
  },

  view(s, size) {
    return box({ pad: 1, h: "fill" }, [
      box({ border: "round", borderColor: "cyan", pad: [0, 1], title: "NAME" }, [
        text(\`\${size.cols}x\${size.rows} · \${s.ticks}s\`, { dim: true }),
      ]),
      text(""),
      list(s.items, s.cursor),
      spacer(),
      row([text("↑/↓ move", { dim: true }), spacer(), text("q quit", { dim: true })]),
    ]);
  },
});
`;

const VERCEL = `import { experimental_upgradeWebSocket } from "@vercel/functions";
import { vercelSsh } from "@lithe/app/vercel-ssh";
import app from "../app.ts";

// One function, both doors: an SSH session on an Upgrade request, the manifest
// and the stateless frame protocol otherwise.
const handler = vercelSsh(app, { upgrade: experimental_upgradeWebSocket });

export const GET = handler;
export const POST = handler;
export default handler;
`;

const WORKER = `import { cloudflareSsh } from "@lithe/app/cloudflare-ssh";
import app from "./app.ts";

// One Worker, three front doors:
//   GET  /            the manifest
//   POST /            the stateless frame protocol, for relay access
//   GET  /_lithe/ssh  a complete SSH session, terminated right here
export default cloudflareSsh(app);
`;

const WRANGLER = `name = "NAME"
main = "worker.ts"
compatibility_date = "2026-01-01"

# The only secret you need. It is the host key — same seed, same fingerprint,
# forever — and it also signs session state in relay mode:
#   bunx wrangler secret put LITHE_SSH_SEED
`;

const VERCEL_JSON = `{
  "functions": { "api/tui.ts": { "maxDuration": 300 } },
  "rewrites": [
    { "source": "/", "destination": "/api/tui" },
    { "source": "/_lithe/ssh", "destination": "/api/tui" }
  ]
}
`;

const PKG = (name: string) => `{
  "name": ${JSON.stringify(name)},
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "lithe dev app.ts",
    "serve": "lithe serve app.ts",
    "deploy:vercel": "vercel deploy --prod",
    "deploy:cf": "wrangler deploy"
  },
  "dependencies": {
    "@lithe/app": "^0.1.0",
    "@vercel/functions": "^3.9.11",
    "ws": "^8.18.0"
  },
  "devDependencies": { "@lithe/cli": "^0.1.0" }
}
`;

const README = (name: string) => `# ${name}

\`\`\`sh
bun install
bun run dev        # try it in this terminal
\`\`\`

## Deploy

\`\`\`sh
wrangler secret put LITHE_SSH_SEED    # the only secret; keep it
wrangler deploy                        # -> https://${name}.<you>.workers.dev

vercel env add LITHE_SSH_SEED
vercel deploy --prod                   # -> https://${name}.vercel.app
\`\`\`

Using your own domain? Add it in the Vercel or Cloudflare dashboard. That is the
whole procedure — there is no lithe-specific DNS record.

## SSH in

The deployment is its own SSH server, so there is nothing in between:

\`\`\`sh
lithe ssh ${name}.vercel.app
\`\`\`

To make the plain \`ssh\` command work, add one config block, once, for every
lithe app you will ever use:

\`\`\`sh
lithe setup --write
ssh ${name}.vercel.app
\`\`\`

Print the fingerprint you should expect before you connect:

\`\`\`sh
bun -e 'import {fingerprintFor} from "@lithe/app/cloudflare-ssh"; console.log(await fingerprintFor(process.env.LITHE_SSH_SEED))'
\`\`\`

## Notes

- \`LITHE_SSH_SEED\` is the only secret: the host key, and the session signing key.
- Platform bindings (KV, D1, secrets) arrive as \`io.env\`.
- \`io.ctx.pubkey\` is the visitor's verified SSH key fingerprint: a stable user
  id with no signup.
- A relay can also serve this app over plain \`ssh\` with nothing installed on
  the visitor's side — see https://github.com/svviitzerland/lithe/blob/main/docs/RELAY.md
`;

/** Write a ready-to-deploy app: one file of logic, two one-line adapters. */
export async function scaffold(dir: string): Promise<void> {
  const root = resolve(dir);
  const name = basename(root) === "." ? "my-tui" : basename(root);
  await mkdir(`${root}/api`, { recursive: true });
  const files: [string, string][] = [
    ["app.ts", APP.replaceAll("NAME", name)],
    ["api/tui.ts", VERCEL],
    ["worker.ts", WORKER],
    ["wrangler.toml", WRANGLER.replaceAll("NAME", name)],
    ["vercel.json", VERCEL_JSON],
    ["package.json", PKG(name)],
    ["README.md", README(name)],
  ];
  for (const [f, body] of files) {
    await writeFile(`${root}/${f}`, body, { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
      process.stderr.write(`  skipped ${f} (exists)\n`);
    });
  }
  process.stdout.write(
    `created ${name}\n\n` +
      `  bun install\n` +
      `  bun run dev\n\n` +
      `then deploy with wrangler or vercel, and ssh in:\n\n` +
      `  lithe ssh ${name}.vercel.app\n`,
  );
}
