# Deploying a lithe app

Your app is an HTTP endpoint. Deploy it like any other endpoint, then publish one
DNS record so SSH clients can find it.

## Vercel

The handler accepts either calling convention — a Web `Request` or Node's
`(req, res)` — so the same file works on both runtimes and in Next route
handlers.

```ts
// api/tui.ts
import { vercel } from "@lithe/app/vercel";
import app from "../app.ts";

const handler = vercel(app);
export const GET = handler;
export const POST = handler;
export default handler;
```

```sh
vercel env add LITHE_SECRET    # any long random string
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
wrangler secret put LITHE_SECRET
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

### The zero-config path

If your app is reachable at its own hostname, there is nothing to do. The relay
probes `https://<hostname>/api/tui`, then `/tui`, `/api/lithe`, then `/`, and
accepts the first one that answers with a lithe manifest:

```sh
ssh my-app.vercel.app@<relay>
ssh my-app.username.workers.dev@<relay>
```

This exists because you cannot publish a DNS record under `vercel.app` or
`workers.dev`. The manifest requirement is the consent check: a relay cannot be
pointed at a host that has not deployed a lithe app.

### The DNS path

Authoritative, and the only option when the endpoint is not at the hostname a
user types — your own domain, a path under an existing site, a different host
entirely:

```
_lithe.myapp.com.   TXT   "v=lithe1; origin=https://my-app.vercel.app/api/tui"
```

```sh
dig +short TXT _lithe.myapp.com       # check it
ssh myapp.com@<relay>                 # use it
```

No account, no dashboard: the relay reads the record on first connect and caches
it for the TTL. Change the record to move your app; the next session follows.

## Environment and bindings

| Variable | Purpose |
|---|---|
| `LITHE_SECRET` | HMAC key for session blobs. **Set this.** Without it blobs are unsigned, and a hostile relay could tamper with your app's state. |
| `LITHE_RELAY` | Relay hostname used in the connect string on your landing page. Default `lithe.sh`. |

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
