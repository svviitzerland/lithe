# Serving SSH from serverless compute

A technical note on why `ssh your-app.com` cannot be made to work by a
serverless platform alone, what the minimum always-on component is, and how to
shrink that component until it knows nothing.

Everything measured here was measured against live deployments on Cloudflare
Workers and Vercel Functions in October 2026, from a client in Indonesia.

---

## 1. The problem

A TUI served over SSH is a good product — [terminal.shop](https://terminal.shop)
sells coffee that way. But it requires a host that stays up and owns port 22:
a machine, a process supervisor, host keys to protect, an on-call rotation.

Serverless compute removes all of that for HTTP. The question is whether it can
remove it for SSH. It cannot, entirely — but the irreducible remainder is far
smaller than it first appears, and the interesting result is *how small*.

We split the question in two:

- **Reachability.** Can a stock `ssh` client be made to reach a serverless
  function without configuring the client?
- **Termination.** Can the SSH protocol itself run inside a function?

The second turns out to be easy. The first turns out to be impossible, and the
proof is short.

## 2. The client's discovery surface is empty

For `ssh example.com` to reach anything other than `example.com:22`, the client
must be told so. We enumerated every mechanism an unmodified OpenSSH client
consults before connecting.

| Mechanism | Can it redirect host, port or transport? |
|---|---|
| `A` / `AAAA` records | Address only. No port, no protocol. |
| `SRV` records | **Not implemented.** Requested in [bug 2217](http://lists.mindrot.org/pipermail/openssh-bugs/2014-March/013183.html) (2014), a patch was posted and discussed on openssh-unix-dev, and [raised again in May 2025](http://lists.mindrot.org/pipermail/openssh-unix-dev/2025-May/041911.html) with no maintainer decision. Not in any release. |
| `SSHFP` records | Host key *verification* only. Cannot change where the client connects. |
| `CNAME` | Renames; the port stays 22 and the protocol stays SSH-over-TCP. |
| `~/.ssh/config`, `/etc/ssh/ssh_config` | Can redirect — but is client-side configuration, which is what we are trying to avoid. |
| `ProxyCommand`, `ProxyJump` | Same: configuration or a command-line flag. |
| Pre-banner lines (RFC 4253 §4.2) | The server may send text before its version string, and clients must tolerate it. But the client has already connected to :22 to read it. Informational only. |
| In-protocol redirect | None exists. `SSH_MSG_DISCONNECT` carries a reason string and nothing actionable. |
| SNI or any hostname in the handshake | None. The client sends a version banner; the username lives inside the encrypted channel. |

**Result.** There is no in-band or out-of-band mechanism by which a stock SSH
client can be redirected. Something must accept a TCP connection on port 22 at
the address the hostname resolves to. This is a property of the protocol, not of
any platform, and no amount of code in a serverless function changes it.

A useful corollary: because the handshake carries no hostname, a layer-4 proxy
cannot demultiplex SSH by name the way TLS SNI allows for HTTPS. **The only
SNI-free demultiplexer is the destination address itself.** We return to this in
§5.

## 3. The transport surface on serverless platforms

If the client must speak TCP, and the platform does not accept TCP, something
must bridge the two. We measured what each platform actually offers.

### 3.1 Raw TCP

Neither Cloudflare Workers nor Vercel Functions accept inbound TCP. Cloudflare
has shipped a `connect()` handler that hands a Worker an inbound socket, but it
arrives through Spectrum, is in private beta, and Spectrum's SSH application is
a paid feature limited to one application per zone. Not a foundation.

### 3.2 Full-duplex HTTP

HTTP/1.1 permits a response to begin before the request body ends. If an edge
platform preserved that, a raw byte tunnel would need no framing at all, and a
client could be built from `openssl s_client` alone — which would mean *nothing
installed*, since openssl ships with every Mac and Linux.

We tested it. A Worker that echoes its request body back as it arrives:

```js
const { readable, writable } = new TransformStream();
req.body.pipeTo(writable);              // echo, without waiting for the end
return new Response(readable);
```

| Request | Result |
|---|---|
| `Content-Length: 1099511627776`, then bytes | **413 Request Entity Too Large** — refused before the Worker ran |
| `Content-Length: 10000000`, byte written at t=2s, read until t=15s | **0 bytes returned** |

Cloudflare buffers the request body before invoking the Worker. There is no
full-duplex HTTP, and the no-install `openssl` bridge is therefore impossible.
This is the single most load-bearing negative result in this note: it is what
forces a WebSocket, and a WebSocket is what forces a real program on one side or
the other.

### 3.3 WebSocket

Available on both platforms — Workers natively, Vercel through
`experimental_upgradeWebSocket` (public beta since June 2026). It is
bidirectional and binary-clean, so it can carry SSH. But RFC 6455 requires
client-to-server frames to be masked with a per-frame key, which rules out
building the client half from shell utilities.

## 4. Terminating SSH inside the function

The second question has a pleasant answer: a complete SSH-2 server fits in an
edge runtime with no native code, provided the algorithm suite is chosen to
avoid bignum arithmetic.

| | Chosen | Why |
|---|---|---|
| Key exchange | `curve25519-sha256` | X25519 is in WebCrypto. Finite-field Diffie-Hellman groups are not, and would need a bignum implementation. |
| Host key | `ssh-ed25519` | Ed25519 sign/verify is in WebCrypto. RSA host keys would too, but Ed25519 keys are 32 bytes and derive cleanly from a seed. |
| Cipher | `aes256-gcm@openssh.com` | AES-GCM is in WebCrypto. `chacha20-poly1305@openssh.com` is not, and would have to be written by hand. |
| MAC | implicit (AEAD) | Avoids a separate HMAC construction. |
| Client auth | ed25519, `rsa-sha2-256/512`, `ecdsa-sha2-nistp256` | All verifiable with WebCrypto, covering every key type in practice. |

Every primitive is `crypto.subtle`. There is no FFI, no WASM and nothing to
compile, so the same code runs on Workers, Vercel, Deno, Bun and Node. An SSH-2
server in this shape is about 1,100 lines of TypeScript.

Two consequences follow, and they are the reason this is worth doing:

1. **The session is end-to-end.** Whatever carries the bytes between the client
   and the function is carrying ciphertext it has no key for.
2. **The host key is the function's.** It is derived from a seed with
   `HKDF-SHA256`, so it is reproducible, has no file to protect, and is
   identical across platforms given the same seed — we verified one fingerprint
   presented from both a Cloudflare Worker and a Vercel Function.

## 5. The irreducible component, and how small it can be

From §2, something must listen on port 22. From §4, that something does not need
to understand SSH. We call it a **pipe**: it accepts a TCP connection, opens a
WebSocket to the app, and copies bytes in both directions.

What the pipe does *not* have is the point:

- no host key, and no key material of any kind
- no authentication, no usernames, no accounts
- no application state, no sessions to resume
- no protocol parser — it never looks at a byte it carries

A component with no secrets and no state is **fungible**. It can be operated by
someone other than the app author, shared between mutually distrusting apps, and
replaced mid-flight without coordination. That is what makes the arrangement
practical: you still need one always-on process, but it can be a utility rather
than a trust anchor.

### 5.1 Demultiplexing without SNI

From §2, the only thing a pipe can route on is the address the connection
arrived at. With IPv4 that means one address per app, which is expensive. With
IPv6 it is free: a single `/64` holds 2⁶⁴ addresses, and a host can carry as many
as its interface allows.

```
app-one.com.  AAAA  2001:db8:1::10
app-two.com.  AAAA  2001:db8:1::20
```

```json
{
  "2001:db8:1::10": "https://app-one.example",
  "2001:db8:1::20": "https://app-two.example"
}
```

The pipe reads the destination address off the accepted socket and looks it up.
No parsing, no SNI, no usernames. We ran two apps through one pipe this way and
confirmed both answer bare `ssh`, with the client verifying each app's own host
key.

This also recovers a property that username-routing loses: because the app is
known before key exchange begins, each app can present **its own host key**. A
relay that terminates SSH cannot do this — it must choose a host key before it
learns which app the user wants.

## 6. Measurements

Demo app, 80×24, client in Indonesia.

| | Cloudflare Workers | Vercel Functions |
|---|---|---|
| Keystroke, SSH terminated in the function | **26–32 ms** p50 | 256 ms p50 |
| Keystroke, via a relay speaking HTTP frames | 126 ms p50 | 305 ms p50 |
| First frame including SSH handshake | 420–480 ms | 3.5–9 s |
| Deployed bundle, SSH server included | 24 kB gzipped | 38 kB |

| Pipe on a `t4g.nano` in `ap-southeast-1` | |
|---|---|
| Keystroke | **46 ms** p50, 8 ms min |
| First frame | 669 ms |
| Resident cost | two goroutines and a 32 kB buffer per connection |

The gap between the two rows of the first table is structural rather than
tuning: a relay that speaks a frame protocol pays one HTTP request per
keystroke, while a terminated SSH session is already open and already holds the
app's state in memory.

## 7. Properties and limits

**What this buys.** The app author runs no server. The visitor configures
nothing. The only always-on component holds no secrets, and the session is
encrypted end to end past it.

**What it costs.**

- One pipe must exist somewhere. It can be shared, but it cannot be zero.
- IPv6 is required for cheap multi-tenancy. IPv4-only clients fall back to one
  address per app, or to a relay that terminates SSH and routes by username.
- A function has a maximum duration. On Vercel the SSH session ends with it —
  300 s by default. Workers hold a WebSocket far longer, but a plain Worker has
  CPU-time limits of its own; long sessions belong in a Durable Object.
- First contact still shows the standard host-key prompt. `SSHFP` records plus
  `VerifyHostKeyDNS` would remove it, but that is a client-side option again.

**Open problems.**

- A pipe that is itself scale-to-zero. Platforms that wake a machine on an
  inbound TCP connection would make the always-on component always-on only in
  name.
- Cloudflare's inbound-TCP `connect()` handler, if it reaches general
  availability, removes the pipe entirely: the Worker takes the socket and the
  SSH server runs unchanged.
- The SSH server implements a security protocol and has had no external review.

## 8. Reproducing this

Everything above is in this repository.

```sh
./scripts/e2e-ssh.sh    # real OpenSSH client against the TypeScript server,
                        # over TCP, over WebSocket, and through the pipe
```

The §3.2 measurement is a ten-line Worker; the method is in that section. The
§5.1 result needs a host with a routed IPv6 block — `relay/deploy/setup-pipe.sh`
configures one.

`docs/reference/lithe-bridge.py` is the client half of §3.3 in 191 lines of
Python standard library, included because it is short enough to read and makes
the transport concrete. Nothing in normal use requires it.
