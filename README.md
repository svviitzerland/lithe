<h1>lithe</h1>

[![ci](https://github.com/svviitzerland/lithe/actions/workflows/ci.yml/badge.svg)](https://github.com/svviitzerland/lithe/actions/workflows/ci.yml)

**Design a terminal app. Deploy it anywhere. People reach it with `ssh`.**

```sh
ssh my-app.com
```

Stock `ssh`. No username, no client install, nothing in `~/.ssh/config`. **The
people who use your app never hear the word lithe** — `lithe` is a build and
deploy tool, and it lives on your machine, not theirs.

Something must listen on port 22; [the SSH protocol leaves no way around
it](docs/SSH-ON-SERVERLESS.md#2-the-clients-discovery-surface-is-empty). So lithe
ships a **pipe**: a byte-splicer that parses nothing, holds no keys, and cannot
read what it carries, because SSH is terminated by your function at the far end.
One pipe serves every app you deploy.

```sh
lithe-relay --addr :22 --pipe https://my-app.vercel.app
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
| Tunnelling bytes over plain HTTPS | **Measured, not assumed:** a Worker that echoes its request body streams back *nothing* until the body ends, and a large `Content-Length` is refused with `413`. Cloudflare buffers request bodies, so there is no full-duplex HTTP to hide SSH inside. A WebSocket is the only bidirectional channel. |

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

## Try the live demos

Really deployed on Cloudflare Workers, really answering `ssh`. Nothing to
install, no key to set up, no domain involved:

```sh
ssh 18.138.186.97.sslip.io                  # the tour
ssh 2406-da18-13ff-fc00--20.sslip.io        # snake
```

Those names are just the pipe's addresses spelled out by
[sslip.io](https://sslip.io), so no domain is needed to reach them. The raw
addresses work the same: `ssh 18.138.186.97`, `ssh 2406:da18:13ff:fc00::20`.

One pipe serves both, routed by destination address, and each app presents **its
own** host key — the pipe holds neither:

| | |
|---|---|
| the tour | `SHA256:hGmH/KOjEpCTbqXMdcspKAk/dzuuTKpJq5PbJAeB4i8` |
| snake | `SHA256:YtqnzCMpDfOImfcjuolvk9xw+MpR2KCFTD0Z6soL4I4` |

The first key is also what `lithe-hello.vercel.app` presents — one seed, two
platforms, so you can move between them without a host-key warning.

IPv4 addresses are scarce, so the one on this box serves a single app; snake
lives on IPv6, where addresses are free. That asymmetry is the whole reason §5.1
of the [technical note](docs/SSH-ON-SERVERLESS.md) recommends a `/64`.

**From this repo, while you are building:**

```sh
git clone https://github.com/svviitzerland/lithe && cd lithe && bun install
bunx @lithe/cli ssh lithe-hello.vercel.app     # a deployment with no pipe yet
```

`lithe ssh` bridges from your own machine so you can test before a pipe is in
front of it. It is a developer tool; your users never run it.

## Run it yourself in 60 seconds

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
// api/tui.ts — Vercel: one function, both doors
import { experimental_upgradeWebSocket } from "@vercel/functions";
import { vercelSsh } from "@lithe/app/vercel-ssh";
import app from "../app.ts";
const handler = vercelSsh(app, { upgrade: experimental_upgradeWebSocket });
export const GET = handler;
export const POST = handler;
export default handler;
```

```sh
lithe deploy      # generates the host key, installs it as a secret, deploys
```

There is no `.env` to write. The first deploy generates a random seed, keeps it
in `.lithe/hostkey` (git-ignored, mode 600) and installs it as a Cloudflare
secret or Vercel environment variable. Every deploy after that reuses it, which
is what keeps the SSH fingerprint stable. If a key is already on the platform,
`lithe deploy` leaves it alone rather than silently rotating it and warning every
client.

Using your own domain? Add it in the dashboard, as you would for any site. There
is no lithe-specific DNS record to publish and nothing to register.

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

## How people reach it

| | what the visitor does | what you run | who can read the session |
|---|---|---|---|
| **Pipe** — the one to use | `ssh my-app.com` | a byte-splicer on any box with port 22 | **nobody** |
| **Relay** | `ssh my-app.vercel.app@relay` | nothing, if you use a shared relay | the relay |
| **Local bridge** — for your own testing | `lithe ssh my-app.vercel.app` | nothing | nobody |

The pipe is the answer: free for the visitor, and private, because it never
terminates SSH — the client verifies *your function's* host key straight through
it. The local bridge exists so you can test a deployment before a pipe is in
front of it; it is not something to ask anyone else to run.

**Pipe.** One flag, and `ssh your-app.com` works for everyone:

```sh
lithe-relay --addr :22 --pipe https://my-app.vercel.app
```

Many apps on one box route by **destination address** — one IPv6 each, out of a
`/64` you already have. SSH carries no hostname, so the address is the only thing
a proxy can demultiplex on; IPv6 makes that free:

```
app-one.com.  AAAA  2406:…::10        {"2406:…::10": "https://app-one.vercel.app",
app-two.com.  AAAA  2406:…::20         "2406:…::20": "https://app-two.workers.dev"}
```

```sh
lithe-relay --addr :22 --pipe-map pipes.json
```

Both answer bare `ssh`, each presenting its own host key, with nothing on the
client. See [docs/RELAY.md](docs/RELAY.md).

**Relay.** A small Go binary that terminates SSH and speaks the frame protocol to
your endpoint over HTTP. Nothing to install for the visitor, and nothing to
register: it finds your app by asking the hostname for a manifest. A
platform-assigned hostname works immediately, and so does your own domain the
moment you add it in the dashboard. See [docs/RELAY.md](docs/RELAY.md).

### Why a listener is unavoidable

We enumerated every mechanism an unmodified `ssh` client consults before
connecting — `A`/`AAAA`, `SRV` (requested in 2014, never implemented), `SSHFP`,
`CNAME`, pre-banner lines, in-protocol redirects — and none of them can send the
client anywhere but `host:22`. We also measured whether SSH could ride inside
plain HTTPS instead: a Cloudflare Worker that echoes a streaming request body
returns **zero bytes** until the body ends, and a large `Content-Length` is
refused with `413`. There is no full-duplex HTTP to hide in.

So a listener must exist. The contribution is making it hold nothing: no keys, no
state, no parser. The full argument, with the measurements, is in
[docs/SSH-ON-SERVERLESS.md](docs/SSH-ON-SERVERLESS.md).

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
packages/cli      lithe dev / deploy / init — a developer tool, never the visitor's
relay             the pipe (parses nothing) and the relay (terminates SSH), in Go
examples/         hello, snake, guestbook — see examples/README.md
docs/reference/   a 191-line Python ssh-over-WebSocket client, for reading
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
