# The lithe protocol (v1)

One POST per batch of input. JSON, no framing, no handshake. Anything that can
make an HTTP request can host a lithe app; anything that can accept a terminal
can be a client.

## Request

`POST <origin>` with `content-type: application/json`:

```jsonc
{
  "v": 1,
  "sid": "a1b2c3d4e5f60718",   // stable for one SSH connection
  "session": "ADdK…",          // opaque app state; absent on the first call
  "vst": "AHgAKA…",            // opaque view-diff state; absent on the first call
  "full": false,               // true = "I have nothing to diff against"
  "size": [120, 40],           // [cols, rows]
  "events": [{ "t": "key", "key": "down" }],
  "ctx": {
    "user": "myapp.com",            // the SSH username (= routing label)
    "pubkey": "SHA256:x3f…",        // client key fingerprint, a stable user id
    "ip": "203.0.113.9",
    "term": "xterm-256color",
    "app": "myapp.com"
  }
}
```

### Events

| Event | Meaning |
|---|---|
| `{ t: "init" }` | first event of a session, before any input |
| `{ t: "key", key, rune? }` | `key` is canonical (`"a"`, `"ctrl+c"`, `"shift+tab"`, `"up"`, `"f5"`, `"enter"`, `"backspace"`, `"space"`). `rune` is present only for printable characters |
| `{ t: "paste", data }` | a bracketed paste, delivered whole |
| `{ t: "resize", cols, rows }` | the window changed |
| `{ t: "tick" }` | the `wake` you asked for has elapsed |
| `{ t: "close" }` | the client is going away (best effort) |

Events are ordered and must be folded in order. A batch can contain several keys
if the user typed quickly — the relay coalesces an 8 ms window.

## Response

```jsonc
{
  "v": 1,
  "session": "ADdK…",     // echo this back next time
  "vst": "AHgAKA…",       // echo this back next time
  "partial": true,        // frame contains only changed rows
  "frame": {
    "w": 120,
    "h": 40,
    "pal": [{}, { "fg": 6, "at": 1 }, { "fg": "#36d7b7" }],
    "rows": [
      null,                          // unchanged since the last frame
      [[" lithe", 1], ["  demo", 2]] // [text, paletteIndex]
    ],
    "cursor": [10, 9],               // omit to hide the cursor
    "title": "lithe · demo",
    "bell": false
  },
  "wake": 1000,           // send me a tick in 1000ms
  "exit": null,           // a number closes the session with that status
  "err": ""               // written to the client's stderr
}
```

### Frames

A frame is a palette plus one entry per row. Each row is a list of runs, and a
run is `[text, paletteIndex]`. Palette index `0` is always the terminal default.

```jsonc
{ "fg": 6 }           // xterm palette index 0-255
{ "fg": "#36d7b7" }   // truecolor; clients degrade to the 6×6×6 cube
{ "at": 9 }           // attribute bitmask
```

Attributes: `1` bold, `2` dim, `4` italic, `8` underline, `16` reverse, `32`
strikethrough.

Rules a client must follow:

- Runs cover columns left to right. A double-width glyph consumes two columns;
  compute widths with the same table as `packages/core/src/width.ts`.
- A row shorter than `w` is padded with default-styled spaces. Trailing blank
  runs are omitted on purpose.
- `rows[i] === null` means "keep what you already have on that line". If you have
  nothing — first frame, after a resize, after reconnecting — set `full: true` on
  the request and you will be sent every row.
- `cursor` absent means hide the cursor.

### The two opaque blobs

Neither is interpretable by the client; both must be echoed back verbatim.

- **`session`** — your app's state. `flags | hmac(16) | gzip?(json)`, base64url,
  HMAC-SHA256 over `flags || payload` with `LITHE_SECRET`. Capped at 64 kB. An
  unverifiable blob is not an error: the origin starts a fresh session and
  replays `init`, so a restarted relay degrades to "the app restarted".
- **`vst`** — one 32-bit FNV-1a hash per row, packed as
  `u16 w | u16 h | u32[h]` and base64'd. This is what lets a function with no
  memory send a partial frame.

## `GET <origin>`

Returns a manifest, or an HTML page showing the connect command when the request
accepts `text/html`:

```json
{
  "lithe": 1,
  "name": "lithe demo",
  "modes": ["stateless"],
  "description": "…",
  "connect": "ssh demo.example@lithe.sh"
}
```

## Discovery

There is no registry and no DNS record. A relay or pipe locates an app by asking
its hostname, in order:

```
/_lithe/ssh    /api/tui    /tui    /
```

A candidate is accepted only when it returns `200` with a JSON body containing a
numeric `lithe` field. That requirement is what makes discovery safe: being
reachable over SSH is something a deployment opts into by answering with a
manifest, not something that can be pointed at it from outside.

Relays should cache per hostname for a short time (ours: 60 s), require `https`,
and refuse origins that resolve to loopback, private or link-local addresses.

## Versioning

`v` is the protocol version on both messages. A relay that receives a higher `v`
than it knows should still render `frame` — the shape of a frame will not change
incompatibly within v1. New fields are additive and optional.
