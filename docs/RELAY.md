# Running a relay

> You may not need this at all. If your deployment terminates SSH itself — see
> [SSH.md](SSH.md) — there is no relay in the path and nothing here applies.
> Relay mode exists because it asks nothing of the visitor: plain `ssh`, no
> client-side setup. The trade is that the relay terminates the session and can
> therefore see it.

The relay is one static Go binary with no state, no database and no config file.
Running your own takes a minute and gives you a bare `ssh yourapp.com` instead of
`ssh yourapp.com@shared-relay`.

## One app, your own domain

```sh
go build -o lithe-relay ./relay

./lithe-relay \
  --addr :22 \
  --origin https://my-app.vercel.app/api/tui \
  --app-id my-app \
  --seed "$(openssl rand -hex 32)"
```

Point an `A`/`AAAA` record at the box and you are done:

```sh
ssh my-app.com
```

Save the seed. It *is* your host key — same seed, same fingerprint, forever, on
any machine. Print it any time:

```sh
./lithe-relay --seed "$SEED" --print-fingerprint
# SHA256:LrjAyzAX/W0VRaD7D8KQnT7btr/7u5n7NKnMHgs5dBc
```

Publish it so clients can verify on first connect:

```
my-app.com.  SSHFP  4 2 <sha256 of the key, hex>
```

…and tell people to use `ssh -o VerifyHostKeyDNS=yes my-app.com`.

## Many apps, one relay

```sh
./lithe-relay --addr :22 --seed "$SEED"            # dns + probe (default)
```

Two ways an app gets found, tried in this order:

1. **`_lithe.<domain>` TXT** — authoritative. Points anywhere.
2. **Probing** — `GET https://<domain>/api/tui`, then `/tui`, `/api/lithe`, `/`.
   A candidate counts only if it answers with a lithe manifest. This is what
   makes `ssh my-app.vercel.app@your-relay` work with nothing configured, since
   nobody can publish DNS under `vercel.app`.

Disable either with `--dns=false` or `--probe=false`. Or pin a static map:

```json
// routes.json
{
  "shop":  "https://shop.example/api/tui",
  "blog":  "https://blog.example/api/tui"
}
```

```sh
./lithe-relay --routes routes.json --dns=false
ssh shop@your-relay
```

## Docker

```sh
docker build -t lithe-relay ./relay
docker run -p 22:2222 -e LITHE_SEED=$SEED \
  -e LITHE_ORIGIN=https://my-app.vercel.app/api/tui lithe-relay
```

## Fly.io

`relay/fly.toml` is ready to go. Fly gives you a real TCP port, which is exactly
the one thing serverless will not.

```sh
cd relay
fly launch --no-deploy
fly secrets set LITHE_SEED=$(openssl rand -hex 32)
fly secrets set LITHE_ORIGIN=https://my-app.vercel.app/api/tui
fly deploy
fly ips list      # point your DNS here
```

A 256 MB shared-cpu-1 machine handles a lot: the relay's per-session cost is one
cell grid and one HTTP connection.

## Flags

| Flag | Default | |
|---|---|---|
| `--addr` | `:2222` | listen address |
| `--origin` | — | serve a single app, ignore the username |
| `--app-id` | — | app name reported to a single origin; also the host-key label |
| `--routes` | — | JSON file: ssh username → origin URL |
| `--dns` | `true` | resolve unknown usernames via `_lithe.<domain>` TXT |
| `--probe` | `true` | if DNS has nothing, probe well-known paths on the hostname |
| `--seed` | — | host key seed; **set it**, or the fingerprint changes on restart |
| `--allow-private` | `false` | permit `http://` and private-network origins (local dev) |
| `--max-rps` | `30` | origin requests per second, per session |
| `--coalesce` | `8ms` | input batching window |
| `--idle` | `10m` | disconnect after inactivity |
| `--max-session` | `4h` | hard cap on one session |
| `--timeout` | `10s` | origin request timeout |
| `--print-fingerprint` | | print the host key fingerprint and exit |
| `-v` | | one log line per session |

All of them also read `LITHE_`-prefixed environment variables.

## Security posture

- **Any public key is accepted.** The relay is a front door, not a gate; the
  fingerprint is handed to the app as a stable user id and the app decides what
  it means. Connections without a key arrive as `anon`.
- **Origins must be `https`** and must not resolve to loopback, private or
  link-local addresses. Without this a TXT record could aim the relay at someone's
  internal network. `--allow-private` disables the check for local development
  only.
- **Probing requires a lithe manifest.** The relay will not forward a session to
  a host that does not answer `{"lithe":1,...}`, so discovery by convention
  cannot be used to proxy arbitrary traffic. Responses are capped at 64 kB with a
  5 s timeout.
- **Session blobs are opaque to the relay** and signed by the origin when
  `LITHE_SECRET` is set. A relay operator can see your frames — they are drawing
  them — but cannot forge your app's state. Run your own relay for anything
  sensitive.
- **Rate limits are per session.** Add a reverse proxy or firewall limit if you
  expect abuse at the connection level.

## Why not bare `ssh yourapp.com` on a shared relay?

Because SSH has no SNI. The server sees a TCP connection and an encrypted
username, never a hostname, so a shared relay cannot tell `a.com` from `b.com` if
both point at the same IP. Your options, in order of effort:

1. **`ssh yourapp.com@shared-relay`** — zero effort, one DNS TXT record.
2. **Run your own relay** — one binary, one A record, bare hostname.
3. **An address per app** — a relay with a routed IPv6 `/64` can give every app
   its own `AAAA` and recover the app from the connection's local address. Planned;
   see [ROADMAP.md](ROADMAP.md).
