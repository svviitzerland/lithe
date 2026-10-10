import { box, defineApp, input, row, rule, spacer, text, type Child } from "@lithe/app";

/**
 * Two things this example is about:
 *
 *  1. Identity for free. SSH clients present a public key, so the app gets a
 *     stable per-user id (`io.ctx.pubkey`) with no signup and no password.
 *  2. State that outlives a session. The session blob is per-connection; a
 *     guestbook needs a store. Bind one and it is used; bind nothing and the
 *     app still runs, saying so.
 */

interface Entry {
  who: string;
  message: string;
  at: number;
}

interface State {
  entries: Entry[];
  draft: string;
  caret: number;
  saving: boolean;
  persistent: boolean;
  error: string | null;
}

/** Minimal shape of a Cloudflare KV binding — no wrangler types needed. */
interface KVLike {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
}

interface Bindings {
  GUESTBOOK?: KVLike;
}

const KEY = "entries";
const MAX = 50;

function store(env: Bindings): KVLike | undefined {
  const kv = env.GUESTBOOK;
  return kv && typeof kv.get === "function" ? kv : undefined;
}

function shortId(pubkey: string | undefined): string {
  if (!pubkey) return "anon";
  return pubkey.replace(/^SHA256:/, "").slice(0, 8);
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export default defineApp<State, Bindings>({
  name: "guestbook",
  description: "Sign a guestbook over SSH. Your key is your identity.",

  async init(_ctx, env) {
    const kv = store(env);
    let entries: Entry[] = [];
    if (kv) {
      try {
        entries = ((await kv.get(KEY, "json")) as Entry[] | null) ?? [];
      } catch {
        entries = [];
      }
    }
    return { entries, draft: "", caret: 0, saving: false, persistent: !!kv, error: null };
  },

  async update(s, ev, io) {
    if (ev.t !== "key") return;
    const k = ev.key;

    if (k === "ctrl+c") return io.exit();

    if (k === "enter") {
      const message = s.draft.trim();
      if (!message) return;
      const entry: Entry = { who: shortId(io.ctx.pubkey), message: message.slice(0, 120), at: Date.now() };
      s.entries = [entry, ...s.entries].slice(0, MAX);
      s.draft = "";
      s.caret = 0;

      const kv = store(io.env);
      if (kv) {
        s.saving = true;
        try {
          await kv.put(KEY, JSON.stringify(s.entries));
          s.error = null;
        } catch (err) {
          s.error = err instanceof Error ? err.message : String(err);
        } finally {
          s.saving = false;
        }
      }
      return;
    }

    if (ev.rune) {
      s.draft = s.draft.slice(0, s.caret) + ev.rune + s.draft.slice(s.caret);
      s.caret++;
    } else if (k === "backspace" && s.caret > 0) {
      s.draft = s.draft.slice(0, s.caret - 1) + s.draft.slice(s.caret);
      s.caret--;
    } else if (k === "left") {
      s.caret = Math.max(0, s.caret - 1);
    } else if (k === "right") {
      s.caret = Math.min(s.draft.length, s.caret + 1);
    }
  },

  view(s, size, io) {
    const me = shortId(io.ctx.pubkey);
    const rows: Child[] = s.entries.length
      ? s.entries.slice(0, Math.max(1, size.rows - 9)).map((e) =>
          row({ gap: 1 }, [
            text(e.who.padEnd(8), { fg: e.who === me ? "cyan" : 244, bold: e.who === me }),
            text(e.message, { wrap: false, grow: 1 }),
            text(ago(e.at), { dim: true }),
          ]),
        )
      : [text("nothing here yet. be the first.", { dim: true, italic: true })];

    return box({ pad: 1, gap: 1, h: "fill" }, [
      row([
        text("guestbook", { bold: true, fg: "magenta" }),
        spacer(),
        text(s.persistent ? "store: bound" : "store: none, entries vanish", {
          dim: true,
          fg: s.persistent ? undefined : "yellow",
        }),
      ]),
      text(`you are ${me}${io.ctx.pubkey ? "" : " (no key offered)"}`, { dim: true }),
      rule(),
      box({ grow: 1, gap: 0 }, rows),
      rule(),
      s.error ? text(`could not save: ${s.error}`, { fg: "red" }) : null,
      input(s.draft, s.caret, { label: "say:", width: Math.min(60, size.cols - 8), focused: true }),
      text(s.saving ? "saving…" : "enter to sign · ctrl+c to leave", { dim: true }),
    ]);
  },
});
