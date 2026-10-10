<h1>lithe</h1>

[![ci](https://github.com/svviitzerland/lithe/actions/workflows/ci.yml/badge.svg)](https://github.com/svviitzerland/lithe/actions/workflows/ci.yml)

**Design a terminal app. Deploy it anywhere. People reach it with `ssh`.**

```sh
ssh my-app.vercel.app
```

No server to keep alive, no port 22 to open, no TLS to manage, no browser, no
bundle. Your app is one file that deploys to Vercel or Cloudflare Workers like
any other HTTP endpoint — and it answers `ssh`.

```ts
import { defineApp, box, text, list } from "@lithe/app";

export default defineApp({
  init: () => ({ cursor: 0, items: ["one", "two", "three"] }),

  update(s, ev, io) {
    if (ev.key === "q") return io.exit();
    if (ev.key === "down") s.cursor++;
    if (ev.key === "up") s.cursor--;
  },

  view: (s) => box({ border: "round", pad: 1, title: "hello" }, [
    text("pick one", { dim: true }),
    list(s.items, s.cursor),
  ]),
});
```

That is the whole app. `lithe dev` runs it in your terminal; one `wrangler deploy`
puts it behind an `ssh` command.

> **Status.** Everything below runs today. The demo is live on
> [Cloudflare Workers](https://lithe-hello.farhanauliandastudy.workers.dev) and
> [Vercel](https://lithe-hello.vercel.app), both serving real `ssh` sessions, and
> CI drives a stock OpenSSH client end to end on every push. It is young code in
> a security-sensitive position and has had no external audit.

---

## The problem

SSH apps are wonderful — [terminal.shop](https://terminal.shop) sells coffee over
SSH, and Charm's [Wish](https://github.com/charmbracelet/wish) made them easy to
write. But they need **a machine that stays up and owns port 22**: a VPS, a
process manager, a firewall, host keys to back up, something to page you at 3am.

"Just deploy it serverless" does not work, and it is worth being precise about
why:

| Constraint | Reality |
|---|---|
| SSH needs inbound TCP on port 22 | Vercel Functions and Cloudflare Workers accept **HTTP only**. Cloudflare's inbound-TCP-to-Workers feature exists but is **private beta and needs Spectrum** (SSH is Pro+, one app, a CNAME per app). |
| Routing many apps on one port | SSH has **no SNI**. No hostname in the handshake, and the username is encrypted — so no layer-4 proxy can tell which app a connection wants. |
| A session outliving a request | Serverless functions are killed at a duration limit. |

lithe answers all three by moving the SSH server **into the function**, and by
carrying it over the one thing every platform does support: an HTTPS WebSocket.

## How it works

```
   you                                                     your code
┌─────────┐                                           ┌──────────────────┐
│  ssh    │══════ SSH, end-to-end encrypted ══════════▶│  Worker / Vercel │
└─────────┘    (inside an HTTPS WebSocket, :443)        │  @lithe/ssh      │
                                                        └──────────────────┘
          the tunnel carries ciphertext it cannot read,
            holds no keys, and can be your own machine
```

`@lithe/ssh` is a complete SSH-2 server in TypeScript on WebCrypto:
`curve25519-sha256` key exchange, `ssh-ed25519` host keys,
`aes256-gcm@openssh.com` transport, real `publickey` auth. The algorithm suite is
chosen so that **no bignum arithmetic is needed** — no DH groups, no RSA key
exchange — which is exactly why it fits in an edge runtime with no native code.

Three consequences:

- **Nothing in the middle is trusted.** The session is end-to-end between the
  `ssh` client and your function. Whatever carries the bytes cannot read them.
- **Your SSH key is the login.** `io.ctx.pubkey` is a verified fingerprint: a
  stable user id with no signup, no password, no cookie.
- **A keystroke is not a request.** The connection is already open and state is
  already in memory. Measured **p50 26 ms** on Workers.

## Try it in 60 seconds

```sh
bun install
bun run dev        # the demo app, in your own terminal

bun run ssh        # a real SSH server on :2200, written in TypeScript
ssh -p 2200 you@127.0.0.1
```

Or `./scripts/e2e-ssh.sh`, which does both and checks what came back.

## Deploy

```sh
bunx @lithe/cli init my-app && cd my-app
```

You get one `app.ts` and adapters that are one line each:

```ts
// worker.ts — Cloudflare Workers: HTTP and SSH in one Worker
import { cloudflareSsh } from "@lithe/app/cloudflare-ssh";
import app from "./app.ts";
export default cloudflareSsh(app);
```

```ts
// api/ssh.ts — Vercel
import { experimental_upgradeWebSocket } from "@vercel/functions";
import { vercelSsh } from "@lithe/app/vercel-ssh";
import app from "../app.ts";
export const GET = vercelSsh(app, { upgrade: experimental_upgradeWebSocket, seed: process.env.LITHE_SSH_SEED });
```

```sh
wrangler secret put LITHE_SSH_SEED   # the host key: same seed, same fingerprint, forever
wrangler deploy
```

Adapters also ship for Deno Deploy, Bun and Node. Platform bindings reach the app
as `io.env`, so KV, D1, R2 and secrets work as usual:

```ts
defineApp<State, { NOTES: KVNamespace }>({
  async init(ctx, env) {
    return { notes: (await env.NOTES.get("all", "json")) ?? [] };
  },
  ...
});
```

See [docs/DEPLOY.md](docs/DEPLOY.md) and [docs/SSH.md](docs/SSH.md).

## Two ways in

| | what the visitor does | what you run | who can read the session |
|---|---|---|---|
| **Direct** (recommended) | `lithe ssh my-app.vercel.app`, or plain `ssh` after one `lithe setup` | nothing | nobody |
| **Relay** | plain `ssh my-app.vercel.app@relay`, nothing installed | nothing, if you use a shared relay | the relay |

**Direct.** `lithe ssh <host>` runs your real `ssh` binary through a local bridge
to the app's HTTPS endpoint. To make the stock `ssh` command work on its own, one
block covers every lithe app, forever:

```sh
lithe setup --write     # adds a ProxyCommand block to ~/.ssh/config
ssh my-app.vercel.app   # stock ssh, no username, no relay
```

**Relay.** A small Go binary that terminates SSH and speaks the frame protocol to
your endpoint over HTTP. Nothing to install for the visitor, and it finds your app
by probing `https://<hostname>/api/tui` — so a platform-assigned hostname works
with no configuration. Point it at your own domain with one DNS record instead:

```
_lithe.myapp.com.   TXT   "v=lithe1; origin=https://my-app.vercel.app/api/tui"
```

See [docs/RELAY.md](docs/RELAY.md).

### Why `ssh myapp.com` needs one of the two

Something must accept a TCP connection on `myapp.com:22`. SSH offers no SNI, no
hostname in the handshake and no redirect, so there is no protocol trick that
avoids it. The honest options are: a bridge on the client (`ProxyCommand`), a
relay with a dedicated address per app, or your own listener. lithe gives you all
three; `@lithe/app/ssh-bun`'s `listenSsh` is the last one in two lines.

## What it costs to run

Measured, not estimated — the demo app, called from Indonesia:

| | Cloudflare Workers | Vercel Functions |
|---|---|---|
| Keystroke, SSH in the function | **26–32 ms** p50 (min 14 ms) | 256–259 ms p50 |
| Keystroke, via relay + HTTP | 126 ms p50 | 305 ms p50 |
| First frame, cold | 420–480 ms | 3.5–9 s (varies a lot) |
| Deployed bundle | 24 kB gzipped, SSH server included | 38 kB |

| | |
|---|---|
| Compute per rendered frame | **0.19 ms** at 120×40 |
| Frame response, relay mode | **489 bytes** gzipped |
| Session state blob, relay mode | **176 bytes** |
| A whole game of snake over SSH | **2.7 kB**, 14 frames |
| Relay binary | **7.3 MB**, static, no libc |
| Dependencies in the app runtime | **zero** |

Workers wins on latency because it runs the function near the caller. In relay
mode the relay coalesces input over 8 ms and caps 30 requests/second/session, so
a held key cannot run up an invoice.

## Honest limits

- **Vercel kills the function at `maxDuration`**, which ends the SSH session with
  it: 300 s default, 5 minutes on Hobby. Workers hold a WebSocket much longer,
  but a plain Worker has CPU-time limits; a Durable Object is the right home for
  very long sessions.
- **Direct mode asks the visitor for one command**, either `lithe ssh` or a
  one-time `lithe setup`. Relay mode asks for nothing but puts a relay in the
  path. Pick your trade.
- **The SSH server is new code.** Unit-tested, and tested end to end against the
  real OpenSSH client on every push, but unaudited.
- **No mouse, no scrollback.** Colour degradation to the 256-colour cube is
  implemented and tested but not yet exercised across real terminals. See
  [docs/ROADMAP.md](docs/ROADMAP.md).

## Layout

```
packages/core     cell grid, layout engine, ANSI diffing, key decoding  (zero deps)
packages/ssh      an SSH-2 server in TypeScript, on WebCrypto            (zero deps)
packages/app      app runtime, wire protocol, session codec, adapters
packages/cli      lithe dev / serve / ssh / pipe / setup / init
relay             the optional SSH front door (Go)
examples/         hello, snake, guestbook — see examples/README.md
test/fixtures/    shared by the TypeScript and Go key decoders
scripts/          e2e.sh (relay path) and e2e-ssh.sh (direct path); CI runs both
```

Published as [`@lithe/app`](https://www.npmjs.com/package/@lithe/app),
[`@lithe/ssh`](https://www.npmjs.com/package/@lithe/ssh),
[`@lithe/core`](https://www.npmjs.com/package/@lithe/core) and
[`@lithe/cli`](https://www.npmjs.com/package/@lithe/cli) — the bare name `lithe`
was taken on npm by an abandoned 2013 package.

## Prior art

lithe exists because of [Charm](https://charm.sh) — Wish and Bubble Tea proved
people want SSH apps, and terminal.shop proved people will use them. The
authoring model here is deliberately Elm-ish for the same reason theirs is.
[OpenTUI](https://opentui.com) showed how far a TypeScript TUI can go; it reaches
for a native Zig core through Bun FFI, which is the right call for a local app and
exactly what cannot run on an edge runtime — hence a pure-TypeScript renderer
here, and a pure-WebCrypto SSH server to go with it.

MIT licensed. Contributions welcome.
