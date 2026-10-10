# SSH inside the function

`@lithe/ssh` is an SSH-2 server written in TypeScript, built on WebCrypto. It
runs wherever your app runs — a Cloudflare Worker, a Vercel Function, Deno, Bun,
Node — which means **a deployment can be its own SSH server**, with nothing in
between to set up or trust.

```
   you                                                  your code
┌─────────┐                                        ┌──────────────────┐
│  ssh    │══════ SSH, end-to-end encrypted ═══════▶│ Worker / Function│
└─────────┘   (carried inside an HTTPS WebSocket)   │  @lithe/ssh      │
                                                    └──────────────────┘
      the tunnel carries ciphertext it cannot read, holds no keys,
                    and can be your own machine
```

## Why bother

The relay in the [other architecture](../ARCHITECTURE.md) works, but it is a
thing that exists: it terminates SSH, so it sees your frames, and someone has to
run it. Moving the SSH server into the function changes the trust model
completely:

| | relay terminates SSH | function terminates SSH |
|---|---|---|
| Who can read the session | the relay | nobody but the endpoints |
| Host key lives | with the relay operator | derived from your own secret |
| Infrastructure you run | a relay | none |
| Per-keystroke cost | 1 HTTP request to your origin | 0 — the session is live |
| Keystroke latency (measured) | p50 126 ms (Workers) | **p50 26–32 ms** (Workers) |
| Where state lives | a signed blob, round-tripped | a variable, for the connection |
| Works on | everything with HTTP | everything with WebSockets |

The latency difference is structural, not tuning: the relay model pays a fresh
HTTP request per keystroke, while here the connection is already open and the
app's state is already in memory.

## What is implemented

| | |
|---|---|
| Key exchange | `curve25519-sha256`, `curve25519-sha256@libssh.org` |
| Host key | `ssh-ed25519` |
| Transport cipher | `aes256-gcm@openssh.com`, `aes128-gcm@openssh.com` |
| Strict KEX | `kex-strict-s-v00@openssh.com` |
| Extension negotiation | `ext-info-c` → `server-sig-algs` |
| Client auth | `publickey` (ed25519, rsa-sha2-256/512, ecdsa-nistp256), `keyboard-interactive` (no prompts), optional `none` |
| Channels | one `session`, `pty-req`, `shell`, `exec`, `env`, `window-change`, `exit-status`, flow control |

The suite was chosen so that **no bignum arithmetic is needed**: curve25519 and
ed25519 only, no Diffie-Hellman groups, no RSA key exchange. Every primitive
comes from WebCrypto, so there is no native code, no FFI and nothing to compile.

Deliberately absent: shells, command execution, port forwarding, agent
forwarding, SFTP, SCP. There is no process to attach to and no filesystem to
expose — the only thing on the other end is your app's `view()`.

## Deploying it

### Cloudflare Workers

```ts
// worker.ts
import { cloudflareSsh } from "@lithe/app/cloudflare-ssh";
import app from "./app.ts";

export default cloudflareSsh(app);
```

```sh
lithe deploy      # makes the host key, installs it, deploys
```

One Worker now answers three ways: `GET /` returns the manifest, `POST /` speaks
the relay frame protocol, and `GET /_lithe/ssh` with an `Upgrade` header carries
a whole SSH session.

### Vercel

```ts
// api/tui.ts — one function answers HTTP and SSH
import { experimental_upgradeWebSocket } from "@vercel/functions";
import { vercelSsh } from "@lithe/app/vercel-ssh";
import app from "../app.ts";

const handler = vercelSsh(app, { upgrade: experimental_upgradeWebSocket });
export const GET = handler;
export const POST = handler;
export default handler;
```

```json
{
  "functions": { "api/tui.ts": { "maxDuration": 300 } },
  "rewrites": [
    { "source": "/", "destination": "/api/tui" },
    { "source": "/_lithe/ssh", "destination": "/api/tui" }
  ]
}
```

Vercel's WebSocket support is in public beta and needs the `@vercel/functions`
and `ws` packages. The helper is passed in rather than imported so this package
carries no Vercel dependency.

### Bun or Node, self-hosted

```ts
import { bunSsh } from "@lithe/app/ssh-bun-ws";       // HTTP + SSH over WebSocket
const { fetch, websocket } = bunSsh(app, { ssh: { seed: process.env.LITHE_SSH_SEED } });
Bun.serve({ port: 8787, fetch, websocket });
```

```ts
import { listenSsh } from "@lithe/app/ssh-bun";        // a real TCP port
await listenSsh(app, { port: 22, seed: process.env.LITHE_SSH_SEED });
```

`listenSsh` is the one configuration where plain `ssh your-domain.com` works with
nothing on the client at all — because something is finally listening on port 22.

## Connecting

Visitors run `ssh your-app.com` and nothing else. That works because a **pipe**
is listening on port 22 and splicing the connection onto your app's WebSocket —
see [RELAY.md](RELAY.md). The pipe is yours to deploy, once, for all your apps;
nobody connecting to them needs to know it exists.

Why a pipe has to exist at all, and why it cannot be replaced by something
clever on the client, is argued with measurements in
[SSH-ON-SERVERLESS.md](SSH-ON-SERVERLESS.md).

### Before a pipe is in front of it

To test a deployment from your own machine, the CLI bridges locally:

```sh
bunx @lithe/cli ssh my-app.vercel.app
```

This runs your real `ssh` binary through a WebSocket bridge, so the crypto, the
key auth and `known_hosts` are all real. It is a developer convenience — do not
ask your users to install anything.

## Host keys

The host key is derived, never stored:

```
HKDF-SHA256(LITHE_SSH_SEED, "lithe-hostkey-v1", "lithe") → ed25519 seed
```

Same seed, same fingerprint, forever, on any platform — we verified the same
fingerprint from a Cloudflare Worker and a Vercel Function sharing one seed, so
you can fail over between platforms without clients seeing a warning.

Print the fingerprint before you deploy, and publish it:

```ts
import { fingerprintFor } from "@lithe/app/cloudflare-ssh";
console.log(await fingerprintFor(process.env.LITHE_SSH_SEED!));
// SHA256:hGmH/KOjEpCTbqXMdcspKAk/dzuuTKpJq5PbJAeB4i8
```

`lithe deploy` does all of this for you: it generates a seed on the first deploy,
keeps it in `.lithe/hostkey` (git-ignored, mode 600) and installs it as a
platform secret. There is no `.env` to write and no value to copy around.

**If no seed reaches the runtime, one is generated per isolate** and the
fingerprint changes on every cold start, which means a host-key warning on every
connection. That is the one failure mode worth watching for.

## Identity

The default auth policy refuses the `none` method, so OpenSSH goes on to offer a
public key. The signature is verified, and the app gets the fingerprint:

```ts
update(state, ev, io) {
  io.ctx.pubkey;  // "SHA256:…", stable per user, no signup, no password
}
```

Clients with no key fall through to `keyboard-interactive`, which asks nothing
and lets them in as `anon`. Pass `allowAnonymous: true` to skip straight to
success and give up the fingerprint, or supply your own `authenticate` to
implement an allowlist.

## Limits worth knowing

- **Vercel kills the function at `maxDuration`.** The session ends with it — 300 s
  by default, up to 800 s on Pro, and five minutes on Hobby. Workers keep a
  WebSocket open far longer, but a plain Worker still has CPU-time limits; a
  Durable Object is the right home for very long sessions.
- **A cold start is a slow handshake.** Measured 420–480 ms to first frame on
  Workers, and 3.5–9 s on Vercel with wide variance. After that, keystrokes settle
  at 26–32 ms and ~256 ms respectively.
- **Bare `ssh your-domain.com` still needs a listener on port 22.** The client-side
  `ProxyCommand` block is what stands in for it; see
  [ARCHITECTURE.md](../ARCHITECTURE.md#why-bare-ssh-hostcom-needs-a-dedicated-address).
- **One session per connection.** Multiplexing (`ControlMaster`), forwarding and
  SFTP are refused rather than half-implemented.
- **This is new code in a security-sensitive position.** The protocol work is
  covered by unit tests and an end-to-end test against the real OpenSSH client on
  every push, but it has had no external audit. For anything sensitive, run it
  where you can see it.
