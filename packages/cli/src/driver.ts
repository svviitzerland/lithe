import { ENTER_TUI, EXIT_TUI, FrameWriter, decodeInput, type Frame } from "@lithe/core";
import type { Event } from "@lithe/app";

export interface StepLike {
  init(): Promise<void>;
  step(events: Event[], size: { cols: number; rows: number }): Promise<{
    frame?: Frame;
    wake?: number;
    exit?: number | null;
    err?: string;
  }>;
}

/**
 * Attaches a runtime to the real terminal: raw mode in, ANSI diffs out.
 * This is the same contract the SSH relay implements, so what you see locally
 * is what an `ssh` user sees.
 */
export async function drive(rt: StepLike, opts: { onExit?: (code: number) => void } = {}): Promise<void> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const writer = new FrameWriter({
    truecolor: /truecolor|24bit/i.test(process.env.COLORTERM ?? ""),
  });

  const size = () => ({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 });

  let queue: Event[] = [{ t: "init" }];
  let running = false;
  let done = false;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;

  const cleanup = (code: number) => {
    if (done) return;
    done = true;
    clearTimeout(wakeTimer);
    stdin.removeAllListeners("data");
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    stdout.write(EXIT_TUI);
    opts.onExit?.(code);
  };

  const schedule = (ms: number) => {
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => {
      queue.push({ t: "tick" });
      void pump();
    }, Math.max(0, ms));
  };

  async function pump(): Promise<void> {
    if (running || done || queue.length === 0) return;
    running = true;
    const events = queue;
    queue = [];
    try {
      const res = await rt.step(events, size());
      if (res.frame) stdout.write(writer.update(res.frame));
      if (res.err) process.stderr.write(`\n${res.err}\n`);
      if (res.wake !== undefined) schedule(res.wake);
      if (res.exit !== undefined && res.exit !== null) {
        cleanup(res.exit);
        return;
      }
    } catch (err) {
      cleanup(1);
      process.stderr.write(`lithe: ${err instanceof Error ? err.message : String(err)}\n`);
      return;
    } finally {
      running = false;
    }
    if (queue.length > 0) void pump();
  }

  await rt.init();

  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  stdout.write(ENTER_TUI);

  stdin.on("data", (chunk: string) => {
    queue.push(...decodeInput(chunk));
    void pump();
  });
  process.on("SIGWINCH", () => {
    const s = size();
    queue.push({ t: "resize", cols: s.cols, rows: s.rows });
    writer.invalidate();
    void pump();
  });
  process.on("SIGINT", () => cleanup(130));
  process.on("exit", () => cleanup(0));

  await pump();
}
