# Deploying a lithe app

Your app is an HTTP endpoint. Deploy it like any other endpoint, then publish one
DNS record so SSH clients can find it.

## Vercel

The handler accepts either calling convention — a Web `Request` or Node's
`(req, res)` — so the same file works on both runtimes and in Next route
handlers.

```ts
// api/tui.ts — one function, both doors
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

```sh
vercel env add LITHE_SSH_SEED    # any long random string
vercel deploy --prod
```

Notes:

- Works on both runtimes: Vercel Functions accept Web-standard
  `Request`/`Response` handlers.
- Keep `maxDuration` small (10–15s). A lithe request is one keystroke, not one
  session, so you never need a long function.
- Next.js App Router works unchanged — put the same handler in
  `app/api/tui/route.ts`.

## Cloudflare Workers

```ts
// worker.ts
import { cloudflare } from "@lithe/app/cloudflare";
import app from "./app.ts";

export default cloudflare(app);
```

```toml
# wrangler.toml
name = "my-app"
main = "worker.ts"
compatibility_date = "2026-01-01"
```

```sh
wrangler secret put LITHE_SSH_SEED
wrangler deploy
```

The adapter reads the secret from `env`, not `process.env`. Workers have no
Node built-ins in play here: the runtime uses only `fetch`, `crypto.subtle`,
`CompressionStream` and `TextEncoder`.

## Deno Deploy

```ts
import { deno } from "@lithe/app/deno";
import app from "./app.ts";
export default deno(app);
```

## Bun / Node / anything with a port

```ts
import { serve } from "@lithe/app/bun";   // or "@lithe/app/node"
import app from "./app.ts";
serve(app, { port: 8787 });
```

Useful for self-hosting the whole thing on one box: run this and the relay side
by side.

## AWS Lambda

Use a Function URL with the Node adapter's `toRequest` shim, or any of the
Web-standard adapters behind an HTTP API. The handler is a plain
`(Request) => Response`, so `createHandler(app)` drops into whatever wrapper your
framework uses.

## Then: getting SSH to it

Nothing to register, nothing to publish. Your app is found at the hostname it is
already served from:

```sh
lithe ssh my-app.vercel.app              # no setup at all
ssh my-app.vercel.app@<relay>            # relay mode, stock ssh
ssh my-app.com                           # pipe mode, stock ssh, no username
```

A relay or pipe discovers the app by asking the hostname for its manifest, trying
`/_lithe/ssh`, then `/api/tui`, `/tui`, `/`, and accepting the first that answers
with `{"lithe":1,...}`. That requirement is the consent check: a relay cannot be
aimed at a host that has not deployed a lithe app.

### Using your own domain

Add it in the Vercel or Cloudflare dashboard, the way you would for any site.
That is the whole procedure — there is no lithe-specific DNS record, no
registration and no config file:

```sh
ssh myapp.com@<relay>     # relay mode
ssh myapp.com             # pipe mode, or after `lithe setup`
```

The relay finds the app by asking the hostname itself for a manifest, trying
`/_lithe/ssh`, then `/api/tui`, `/tui`, `/`. Whatever your domain serves over
HTTPS is what answers `ssh`.

## Environment and bindings

| Variable | Purpose |
|---|---|
| `LITHE_SSH_SEED` | **The one to set.** It is the SSH host key — same seed, same fingerprint, forever — and it signs session blobs in relay mode. |
| `LITHE_SECRET` | Optional. Overrides the signing key if you want it separate from the host key. |
| `LITHE_RELAY` | Optional. Relay hostname shown in the connect string on your landing page. |

Everything the platform gives you reaches the app as `io.env` — the Worker `env`
on Cloudflare, `process.env` elsewhere:

```ts
defineApp<State, { NOTES: KVNamespace; API_KEY: string }>({
  async init(ctx, env) {
    return { notes: (await env.NOTES.get("all", "json")) ?? [] };
  },
  async update(s, ev, io) {
    await fetch(url, { headers: { authorization: `Bearer ${io.env.API_KEY}` } });
  },
  ...
});
```

## Choosing a region

One keystroke is one round trip, so what matters is the distance from the *relay*
to your *origin*, not to the user. Measured from Indonesia against the same app:

| | cold first frame | keystroke p50 |
|---|---|---|
| Cloudflare Workers | 703 ms | **126 ms** |
| Vercel Functions (single region) | 1353 ms | **305 ms** |

Workers wins here only because it runs near the caller. If you run your own
relay, put it in the same region as your function and both numbers collapse.

## Verifying a deployment

```sh
curl https://my-app.vercel.app/api/tui                   # manifest
lithe dev --remote https://my-app.vercel.app/api/tui     # drive the real endpoint
```

`lithe dev --remote` speaks the actual wire protocol against your deployment and
renders it in your terminal. If that looks right, SSH will look right.
