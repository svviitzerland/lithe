# Architecture

This document explains why lithe is shaped the way it is. If you only want to
ship an app, read the [README](README.md) instead.

## The constraint that drives everything

An SSH server must accept an inbound TCP connection, complete a key exchange,
authenticate, open a channel, allocate a pty, and then stream bytes for minutes
or hours. Serverless platforms give you none of that:

- **Vercel Functions** and **Cloudflare Workers** accept HTTP (and WebSocket)
  requests. There is no way to bind port 22.
- **Cloudflare** shipped inbound TCP to Workers via a `connect(socket)` handler,
  but it is in private beta and arrives through **Spectrum**, where SSH is a
  Pro-and-above feature limited to one application with its own CNAME. It is not
  a foundation for "anyone can deploy an SSH app for free".
- **Vercel WebSockets** (public beta since June 2026) hold a connection on one
  instance until the function hits its maximum duration — 300s by default, five
  minutes on Hobby. A terminal session routinely outlives that.

And even with inbound TCP, routing is a problem: **SSH has no SNI.** The protocol
sends no hostname, and the username is inside the encrypted channel. A layer-4
proxy cannot tell which app a connection wants. Something must terminate the SSH
session to find out.

lithe has two answers to this, and they share everything above the transport.

**Direct mode** puts the SSH server inside the function
([`@lithe/ssh`](docs/SSH.md)) and carries it over an HTTPS WebSocket, which every
platform does support. Nothing in the middle terminates SSH, so nothing in the
middle has to be trusted or configured. The cost is one command on the visitor's
side, because a stock `ssh` client speaks TCP and something local has to bridge it.

**Relay mode** accepts the thing that cannot be avoided — one small process owning
port 22 — and makes it as close to nothing as possible: stateless,
configuration-free and interchangeable. The cost is that the relay sees the
session.

The rest of this document describes relay mode, since direct mode has its own
[document](docs/SSH.md). What they have in common is the app contract: `init`,
`update`, `view`, and a frame of styled cells.

## Why bare `ssh host.com` needs a dedicated address

Worth stating plainly, because it is the one thing no amount of engineering
removes.

To run `ssh myapp.com` with no username and no client-side configuration,
something must accept a TCP connection on `myapp.com:22` and know which app is
wanted. SSH gives a server no help here:

- There is no SNI and no hostname anywhere in the handshake.
- The username is inside the encrypted channel, so a layer-4 proxy cannot read it.
- There is no redirect message, and no SRV record support in OpenSSH.
- The only cleartext the client sends first is its version banner.

So the app must be identified by *the address the connection arrived on*. That
leaves exactly four options, and lithe implements all of them:

| | bare `ssh host`? | who sets it up |
|---|---|---|
| `ProxyCommand` bridge on the client (direct mode) | yes, after one `lithe setup` | the visitor, once, for all apps |
| `ssh app@relay` — username routing | no, needs the `app@` prefix | nobody |
| One IPv6 address per app on a shared relay | yes, one AAAA record | the app author (planned) |
| Your own listener (`listenSsh`, or the relay) on port 22 | yes | the app author |

## Division of labour

| | relay (Go, long-lived) | origin (your code, serverless) |
|---|---|---|
| SSH crypto, auth, channels, pty | ✅ | — |
| terminal size, resize signals | ✅ | sees a `resize` event |
| key decoding → canonical names | ✅ | sees `{ key: "ctrl+c" }` |
| frame → ANSI, cell diffing | ✅ | — |
| app state | ❌ holds an opaque blob | ✅ owns it, round-trips it |
| layout, rendering, business logic | — | ✅ |
| rate limiting, idle timeout | ✅ | — |

Everything stateful about *your* app lives in the response payload. Everything
stateful about *the terminal* lives in the relay, where it is cheap (one cell grid
per connection) and reconstructible (a resize forces a full repaint).

## Decision log

**The app is a pure `(state, event) → state` fold plus `state → view`.**
Elm/Bubble-Tea shaped, because it is the model that survives being serialized.
`update` may mutate `state` directly: the object was just deserialized for this
request and is thrown away after, so immutability would be ceremony with no payoff.

**State travels in the response, not in a store.**
A signed, gzipped, base64url blob (`flags | hmac | payload`). This is what makes
the origin genuinely stateless: no sticky sessions, no shared cache, no cleanup of
abandoned sessions, and a redeploy mid-session is invisible. The HMAC exists
because the relay is the one holding your state — a compromised or hostile relay
must not be able to forge it. Without `LITHE_SECRET` the blob is unsigned and the
runtime says so. The 64 kB cap is a deliberate forcing function toward "keep a
handle, not a dataset".

**The origin sends frames; the relay sends ANSI.**
Apps emit a palette plus one array of text runs per row. The relay owns cursor
positioning, SGR sequences, truecolor-vs-256 degradation, and the alt screen. This
keeps the wire format language-neutral — a relay in Rust or a WebSocket client in
a browser can consume the same frames — and it means an app can never corrupt a
terminal with a malformed escape code.

**Row-level diffing, with the hashes in the request.**
A full 120×40 frame is ~1.9 kB of JSON. Resending it per keystroke is wasteful,
but a stateless function cannot remember what it drew. So the response carries a
packed blob of one 32-bit hash per row (`u16 w | u16 h | u32[]`, base64), the relay
echoes it back, and unchanged rows are sent as `null`. The relay already holds the
last frame, so it fills them in. Result: ~489 bytes gzipped per keystroke. When
the relay has nothing to diff against — first frame, resize, reconnect — it sets
`full: true` and gets everything.

**`io.wake(ms)` instead of timers.**
A serverless function cannot hold a `setInterval`. Asking the relay to deliver a
`tick` later gives you clocks, spinners and polling with zero idle cost, and it
makes the frame rate a property of the app rather than the platform.

**Keys are decoded at the relay into canonical names.**
Apps compare `ev.key === "ctrl+c"`, never byte sequences. The decoder exists twice
— `packages/core/src/keys.ts` and `relay/keys.go` — and that duplication is
accepted so the local dev loop and the SSH path produce identical events. Same
story for display width (`width.ts` / `width.go`) and the ANSI differ
(`terminal.ts` / `render.go`). Each pair is small, pure, and easy to test against
the other.

**The username is the routing label, so identity comes from the key.**
`ssh myapp.com@relay` spends the username on routing. Apps get a stable user id
from the SSH public key fingerprint (`ctx.pubkey`), which is better anyway: it
needs no password, no signup, and it is the same thing terminal.shop does.
Connections with no key are reported as `anon`.

**One host key per relay, derived not stored.**
`HKDF-SHA256(seed, "lithe-hostkey-v1", label)` → an ed25519 key. Same seed, same
fingerprint, on any machine, forever — so redeploying the relay does not trigger
host-key warnings, and there is no key file to back up or leak. It is per-relay
rather than per-app because the host key is sent during key exchange, before the
username is known. Per-app fingerprints require per-app addresses; see
[docs/RELAY.md](docs/RELAY.md).

**Discovery by asking the hostname.**
A relay locates an app by requesting a manifest from the hostname the user typed,
trying `/_lithe/ssh`, `/api/tui`, `/tui`, `/`. No registry, no account system, no
DNS record to publish: whoever controls the hostname controls what answers, so
verification is inherent. An earlier design used a `_lithe` TXT record; it was
removed because it only mattered when the app was *not* at the hostname, which
in practice never happens — adding a custom domain in the Vercel or Cloudflare
dashboard puts the app there. One less concept, one less thing to get wrong.

The relay refuses `http://` and origins that resolve to private addresses, so a
hostname cannot turn it into an internal-network proxy.

**Input is coalesced and rate-limited.**
Held keys, pastes and resize storms are batched into one request per 8 ms window,
capped at 30 requests/second/session. One keystroke is one invocation, so the
billing model has to be defended in the relay, not hoped about.

## Transport modes

The app contract is transport-agnostic, which is what let direct mode be added
without touching a single app.

- **Stateless HTTP** (relay mode). Works on every platform. State round-trips in
  a signed blob; one keystroke is one invocation.
- **SSH over WebSocket** (direct mode). The function is the SSH server; state is
  an ordinary variable for the life of the connection. Implemented for Workers,
  Vercel, Bun and Node.
- **Raw TCP.** `listenSsh` on Bun, for self-hosting with no Go binary and no
  bridge. Also how the SSH server is tested against the real OpenSSH client.
- **Raw socket on the platform.** If Cloudflare's inbound-TCP `connect()` handler
  reaches general availability, direct mode loses even the WebSocket: the Worker
  takes the TCP connection and `@lithe/ssh` handles it unchanged.

Nothing about the app changes between these. `update` and `view` do not know which
one is in use.
