import { ENTER_TUI, EXIT_TUI, FrameWriter, decodeInput } from "@lithe/core";
import type { SshSession } from "@lithe/ssh";
import { Runtime, type AppDef, type Env } from "./app.ts";
import type { ClientCtx, Event } from "./protocol.ts";

export interface SshAppOptions<E extends object = Env> {
  /** platform bindings handed to the app as `io.env` */
  env?: E;
  /** app label reported as `io.ctx.app` */
  app?: string;
  /** input batching window; a held key should not be one render per byte */
  coalesceMs?: number;
  /** drop the session after this much silence */
  idleMs?: number;
  /** hard ceiling on renders per second */
  maxFps?: number;
  onLog?(line: string): void;
}

/**
 * Runs a lithe app directly on an SSH session.
 *
 * This is the relay-less path: the SSH server lives in the same process as the
 * app, so there is no frame protocol, no session blob and no HTTP hop. State is
 * just a variable for as long as the connection lasts, and a keystroke costs one
 * local function call plus the network time back to the client.
 */
export async function driveSshSession<S, E extends object = Env>(
  session: SshSession,
  def: AppDef<S, E>,
  opts: SshAppOptions<E> = {},
): Promise<void> {
  const coalesce = opts.coalesceMs ?? 6;
  const idleMs = opts.idleMs ?? 10 * 60_000;
  const minFrameGap = 1000 / (opts.maxFps ?? 60);

  const ctx: ClientCtx = {
    user: session.info.fingerprint ? session.info.user : "anon",
    term: session.info.term,
    ...(session.info.fingerprint ? { pubkey: session.info.fingerprint } : {}),
    ...(opts.app ? { app: opts.app } : {}),
  };

  const rt = new Runtime(def, ctx, opts.env ?? ({} as E));
  await rt.init();

  const writer = new FrameWriter({ truecolor: /256color|truecolor|direct/i.test(session.info.term) });
  let queue: Event[] = [{ t: "init" }];
  let done = false;
  let frames = 0;
  let lastFrame = 0;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let nudge: (() => void) | undefined;

  const finish = (): void => {
    if (done) return;
    done = true;
    clearTimeout(wakeTimer);
    clearTimeout(idleTimer);
    nudge?.();
  };

  session.onClose(finish);
  session.onData((data) => {
    queue.push(...decodeInput(new TextDecoder().decode(data)));
    nudge?.();
  });
  session.onResize((cols, rows) => {
    writer.invalidate();
    queue.push({ t: "resize", cols, rows });
    nudge?.();
  });

  const resetIdle = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(finish, idleMs);
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      const prev = nudge;
      nudge = () => {
        clearTimeout(timer);
        nudge = prev;
        resolve();
      };
    });

  await session.write(ENTER_TUI);
  resetIdle();

  try {
    while (!done) {
      if (queue.length === 0) {
        await sleep(Math.min(idleMs, 30_000));
        continue;
      }
      // Let a burst of keystrokes land in one render.
      if (coalesce > 0) await new Promise((r) => setTimeout(r, coalesce));
      const gap = minFrameGap - (Date.now() - lastFrame);
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      if (done) break;

      const events = queue;
      queue = [];
      const res = await rt.step(events, { cols: session.info.cols, rows: session.info.rows });
      lastFrame = Date.now();
      frames++;
      resetIdle();

      await session.write(writer.update(res.frame));

      if (res.wake !== undefined) {
        clearTimeout(wakeTimer);
        wakeTimer = setTimeout(() => {
          queue.push({ t: "tick" });
          nudge?.();
        }, Math.max(0, res.wake));
      }
      if (res.exit !== undefined && res.exit !== null) {
        finish();
        await session.write(EXIT_TUI);
        await session.exit(res.exit);
        opts.onLog?.(`session ended user=${ctx.user} frames=${frames} exit=${res.exit}`);
        return;
      }
    }
  } catch (err) {
    finish();
    const msg = err instanceof Error ? err.message : String(err);
    opts.onLog?.(`session error: ${msg}`);
    try {
      await session.write(`${EXIT_TUI}\r\nlithe: ${msg}\r\n`);
    } catch {
      /* the client is probably already gone */
    }
  }

  try {
    await session.write(EXIT_TUI);
    await session.exit(0);
  } catch {
    /* already closed */
  }
  opts.onLog?.(`session ended user=${ctx.user} frames=${frames}`);
}
