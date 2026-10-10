import { Runtime, type AppDef, type Env } from "./app.ts";
import { decodeSession, encodeSession } from "./session.ts";
import { PROTOCOL_VERSION, type ClientCtx, type Manifest, type TuiRequest, type TuiResponse } from "./protocol.ts";
import { decodeViewState, diffFrame } from "./viewdiff.ts";

export interface HandlerOpts<E extends object = Env> {
  /** Platform bindings to hand the app (Worker `env`, or your own object). */
  env?: E;
  secret?: string;
  /** shown on the HTML landing page: how a human should connect */
  connect?: string;
  /** relay host used to build the default connect string */
  relay?: string;
}

/** `process.env` when there is one, so non-Workers platforms get their vars. */
function processEnv(): Env {
  try {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  } catch {
    return {};
  }
}

function env(key: string): string | undefined {
  try {
    // process may not exist on edge runtimes
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[key];
  } catch {
    return undefined;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * The portable entry point: a Web-standard `Request -> Response` function.
 * Every adapter in this package is a thin shim over it.
 *
 * - `GET`  returns a manifest (JSON) or a connect page (HTML).
 * - `POST` runs one batch of input and returns the next frame.
 */
export function createHandler<S, E extends object = Env>(def: AppDef<S, E>, opts: HandlerOpts<E> = {}) {
  const secret = opts.secret ?? def.secret ?? env("LITHE_SECRET");
  const relay = opts.relay ?? env("LITHE_RELAY") ?? "lithe.sh";
  const name = def.name ?? "lithe app";

  return async function handle(req: Request): Promise<Response> {
    if (req.method === "GET" || req.method === "HEAD") {
      const manifest: Manifest = {
        lithe: PROTOCOL_VERSION,
        name,
        modes: ["stateless"],
        ...(def.description ? { description: def.description } : {}),
        connect: opts.connect ?? `ssh ${hostOf(req)}@${relay}`,
      };
      const wantsHtml = (req.headers.get("accept") ?? "").includes("text/html");
      if (!wantsHtml) return json(manifest);
      return new Response(landingPage(manifest), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (req.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }

    let body: TuiRequest;
    try {
      body = (await req.json()) as TuiRequest;
    } catch {
      return json({ error: "invalid json" }, 400);
    }

    const cols = clamp(body.size?.[0] ?? 80, 20, 500);
    const rows = clamp(body.size?.[1] ?? 24, 5, 200);
    const ctx: ClientCtx = { ...body.ctx, user: body.ctx?.user || "anon" };

    const rt = new Runtime(def, ctx, opts.env ?? (processEnv() as E));
    let fresh = false;
    if (body.session) {
      const state = await decodeSession<S>(body.session, secret);
      if (state === undefined) fresh = true;
      else rt.resume(state);
    } else {
      fresh = true;
    }
    if (fresh) await rt.init();

    const events = Array.isArray(body.events) ? body.events : [];
    // A reconnect or expired blob replays as a fresh session, not a crash.
    if (fresh && !events.some((e) => e.t === "init")) events.unshift({ t: "init" });

    try {
      const res = await rt.step(events, { cols, rows });
      // Ship only the rows that actually changed; the caller holds the rest.
      const diff = diffFrame(res.frame, decodeViewState(body.vst), fresh || body.full === true);
      const out: TuiResponse = { v: PROTOCOL_VERSION, frame: diff.frame, vst: diff.vst };
      if (diff.partial) out.partial = true;
      if (res.exit === undefined || res.exit === null) {
        out.session = await encodeSession(rt.state, secret);
      } else {
        out.exit = res.exit;
      }
      if (res.wake !== undefined) out.wake = res.wake;
      return json(out);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ v: PROTOCOL_VERSION, exit: 1, err: `app error: ${msg}` } satisfies TuiResponse, 200);
    }
  };
}

function hostOf(req: Request): string {
  try {
    return new URL(req.url).hostname;
  } catch {
    return "your-app.example";
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(n) || lo));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** A deliberately tiny page whose only job is to show the ssh command. */
function landingPage(m: Manifest): string {
  const cmd = escapeHtml(m.connect ?? "");
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(m.name)}</title>
<style>
  :root { color-scheme: dark light; --bg:#0b0d10; --fg:#e6e6e6; --dim:#8b949e; --ac:#36d7b7 }
  body { background:var(--bg); color:var(--fg); font:16px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;
         display:grid; place-content:center; min-height:100vh; margin:0; padding:24px }
  main { max-width:44rem }
  h1 { font-size:1.4rem; margin:0 0 .25rem }
  p { color:var(--dim); margin:.25rem 0 1.5rem }
  code { display:block; background:#13161b; border:1px solid #232830; border-radius:10px;
         padding:14px 16px; color:var(--ac); overflow-x:auto }
  small { color:var(--dim); display:block; margin-top:1rem }
</style>
<main>
  <h1>${escapeHtml(m.name)}</h1>
  <p>${escapeHtml(m.description ?? "A terminal app. There is nothing to see here in a browser.")}</p>
  <code>${cmd}</code>
  <small>Served by lithe — protocol v${m.lithe}</small>
</main>`;
}
