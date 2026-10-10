# Roadmap

Ordered roughly by value per unit of work.

## Next

- **Widgets that earn their keep.** Scrollable viewport with a scrollbar,
  multi-line text area, form/focus manager, modal overlay, markdown renderer.
  The layout engine supports all of it already; these are compositions.
- **Mouse support.** Decode SGR mouse reporting in the relay, deliver
  `{ t: "mouse", x, y, button, action }`. Hit-testing wants a node-id pass over
  the layout tree.
- **WebSocket transport.** For origins that want to push: Durable Objects, a Node
  process, anything with a live connection. The app contract does not change —
  `update`/`view` stay the same, state stays in memory, `io.wake` becomes a real
  timer.
- **A test kit.** A public `renderToString(app, events)` plus golden-frame
  snapshots, so an app can be tested without a terminal. The internals already
  work this way — `packages/core/test` asserts against flattened frames — it just
  needs to be an exported, documented API.

Shipped since the first draft of this document: shared key-decoding fixtures that
both `packages/core` and `relay` must reproduce, platform bindings via `io.env`,
discovery by probing well-known paths, an end-to-end CI job that drives a real
`ssh` client into a stateless function, and — the big one — **`@lithe/ssh`, an
SSH-2 server in TypeScript on WebCrypto**, which lets the function terminate SSH
itself and removes the relay from the trust model entirely.

## Soon

- **Vanity addresses over IPv6.** A relay holding a routed `/64` can hand every
  app its own `AAAA`, read the destination address off the accepted connection,
  and route from that — which also unlocks a **per-app host key**, since the app
  is known before key exchange. This is the clean answer to bare `ssh yourapp.com`
  on shared infrastructure.
- **`lithe deploy`.** Detect the platform, push, create the TXT record through the
  DNS provider's API, print the ssh command. The current four manual steps are
  three too many.
- **Session handoff.** The state blob already makes sessions portable; a signed
  resume token would let a dropped connection reattach to the same screen instead
  of restarting the app.
- **256-colour and dumb-terminal verification.** Degradation is implemented but
  only lightly exercised. Needs a matrix run against real terminals.

## Later

- **Durable Objects for long sessions.** A plain Worker holds a WebSocket well, but
  CPU-time limits make a Durable Object the right home for sessions measured in
  hours. The SSH server already runs there unchanged; this is wiring and docs.
- **Raw TCP on the platform.** If Cloudflare's inbound-TCP `connect()` handler
  reaches general availability, direct mode drops the WebSocket and the client-side
  bridge with it: `ssh your-worker.dev` with nothing in between and nothing
  installed. `@lithe/ssh` needs no changes for this — only a new transport binding.
- **An audit of `@lithe/ssh`.** It implements a security protocol and deserves
  external review before anyone puts something sensitive behind it. Until then the
  README says so.
- **More ciphers.** `chacha20-poly1305@openssh.com` is the one notable absence; it
  is not in WebCrypto, so it would mean a hand-written implementation. AES-GCM is
  negotiated by every modern client, so this is low priority.
- **A browser client.** The frame format is not SSH-specific; a 5 kB WebSocket
  client would render the same app on a web page, which makes "ssh or browser,
  same app" true rather than aspirational.
- **Relays in other languages.** The protocol is small on purpose. A Rust relay on
  `russh` would be a welcome contribution and a good check on whether the spec is
  really complete.
- **Managed relay.** A hosted `lithe.sh` so the zero-effort path needs no
  infrastructure at all. Deliberately last: everything else should work without
  it, and nobody should be locked into it.

## Explicitly not planned

- **A React reconciler.** `view(state) → node` is already declarative, and a
  reconciler would bring a dependency, a scheduler and a diffing layer we do not
  need. If someone wants JSX, a 30-line `h()` over the same node types is enough.
- **Shell access.** lithe serves apps, not shells. There is no pty on the origin
  and no process to attach to — by design.
