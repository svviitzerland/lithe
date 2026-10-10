# Examples

Each example is a complete app: one `app.ts` plus two one-line adapters. Run any
of them locally, then deploy the same file.

```sh
bun run dev                         # the demo (examples/hello)
bunx @lithe/cli dev examples/snake/app.ts
bunx @lithe/cli dev examples/guestbook/app.ts
```

Or over real SSH, against the live deployments:

```sh
bunx @lithe/cli ssh lithe-hello.farhanauliandastudy.workers.dev
bunx @lithe/cli ssh lithe-hello.vercel.app
```

| | what it shows | deployed |
|---|---|---|
| [`hello`](hello) | tabs, lists, an `await fetch` inside `update`, live data on screen | ✅ [Workers](https://lithe-hello.farhanauliandastudy.workers.dev) · [Vercel](https://lithe-hello.vercel.app) — both answer `ssh` |
| [`snake`](snake) | animation with no running process — `io.wake(ms)` drives the clock | ✅ [Workers](https://lithe-snake.farhanauliandastudy.workers.dev) |
| [`guestbook`](guestbook) | identity from the SSH key, and state that outlives the session via a KV binding | — |

## hello

The tour. Three tabs: a list you can move through, a panel that fetches GitHub's
API from inside `update()`, and a text field that proves a keystroke really does
round-trip to a function and back.

## snake

The interesting one, architecturally. A serverless function cannot hold a
`setInterval`, so the game asks the relay to wake it:

```ts
if (!s.dead && !s.paused) io.wake(Math.max(60, 130 - s.score));
```

Each wake-up is one invocation that folds a `tick`, moves the snake and renders.
The whole game — snake, food, score — lives in the session blob, so nothing is
stored anywhere and any instance can serve the next frame. A full game is a few
kilobytes of ANSI.

## guestbook

Two ideas worth stealing:

- **Identity for free.** SSH clients present a public key, so `io.ctx.pubkey` is
  a stable per-user id with no signup, no password, no session cookie.
- **State that outlives a connection.** The session blob is per-connection. For
  anything shared you want a store, reached through `io.env`:

  ```ts
  defineApp<State, { GUESTBOOK: KVNamespace }>({
    async init(ctx, env) {
      return { entries: (await env.GUESTBOOK.get("entries", "json")) ?? [] };
    },
    ...
  });
  ```

  Bind one and it persists; bind nothing and the app still runs, and says so.
  Create the namespace with `bunx wrangler kv namespace create GUESTBOOK`, then
  uncomment the block in `wrangler.toml`.

## Deploying an example from this repo

Examples depend on the packages through the workspace protocol, which Vercel's
installer cannot resolve. Workers is fine — wrangler bundles locally:

```sh
cd examples/snake && bunx wrangler deploy
```

For Vercel, bundle first (the script does it for you):

```sh
./scripts/deploy-vercel.sh examples/hello lithe-hello
```

A real app that installs `@lithe/app` from npm needs none of this — just
`vercel deploy`.
