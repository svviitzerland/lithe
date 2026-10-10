import { renderToScreen, type Frame, type Node } from "@lithe/core";
import type { ClientCtx, Event } from "./protocol.ts";

export interface Size {
  cols: number;
  rows: number;
}

/**
 * Whatever the platform hands the app: KV namespaces, D1, R2, secrets, env vars.
 * Apps usually declare their own shape instead:
 * `defineApp<State, { NOTES: KVNamespace }>({ ... })`.
 */
export type Env = Record<string, unknown>;

/** Side effects an app can request. Everything else is pure state -> view. */
export interface Io<E extends object = Env> {
  /** end the SSH session */
  exit(code?: number): void;
  /** ask to be called again after `ms`, delivering a `tick` event */
  wake(ms: number): void;
  bell(): void;
  title(t: string): void;
  /** show the terminal cursor at this cell (for text inputs) */
  cursor(x: number, y: number): void;
  readonly ctx: ClientCtx;
  /**
   * Platform bindings. On Workers this is the Worker's `env` (KV, D1, R2,
   * secrets); elsewhere it is `process.env`. Typed by the app:
   * `defineApp<State, { NOTES: KVNamespace }>({ ... })`.
   */
  readonly env: E;
}

export interface AppDef<S, E extends object = Env> {
  name?: string;
  description?: string;
  /** Build the initial state for one connection. */
  init(ctx: ClientCtx, env: E): S | Promise<S>;
  /**
   * Fold one input event into state. Mutate `state` freely — it is deserialized
   * fresh for every batch — or return a replacement.
   * May be async: `await fetch(...)` here is the normal way to load data.
   */
  update(state: S, ev: Event, io: Io<E>): void | S | Promise<void | S>;
  /** Describe the screen. Called once per batch, after all events are folded. */
  view(state: S, size: Size, io: Io<E>): Node | Promise<Node>;
  /** HMAC secret for session blobs. Defaults to $LITHE_SECRET. */
  secret?: string;
}

export function defineApp<S, E extends object = Env>(def: AppDef<S, E>): AppDef<S, E> {
  return def;
}

export interface StepResult {
  frame: Frame;
  wake?: number;
  exit?: number | null;
}

/**
 * Drives one app instance. Constructed per request in stateless mode, and once
 * per connection for WebSocket or local dev. Holds no transport knowledge.
 */
export class Runtime<S, E extends object = Env> {
  state!: S;
  private def: AppDef<S, E>;
  private ctx: ClientCtx;
  private env: E;

  constructor(def: AppDef<S, E>, ctx: ClientCtx, env: E = {} as E) {
    this.def = def;
    this.ctx = ctx;
    this.env = env;
  }

  async init(): Promise<void> {
    this.state = await this.def.init(this.ctx, this.env);
  }

  resume(state: S): void {
    this.state = state;
  }

  /** Fold a batch of events, then render. */
  async step(events: Event[], size: Size): Promise<StepResult> {
    let exit: number | null | undefined;
    let wake: number | undefined;
    let bell = false;
    let title: string | undefined;
    let cursor: [number, number] | undefined;

    const io: Io<E> = {
      ctx: this.ctx,
      env: this.env,
      exit: (code = 0) => {
        exit = code;
      },
      wake: (ms) => {
        const v = Math.max(0, Math.floor(ms));
        wake = wake === undefined ? v : Math.min(wake, v);
      },
      bell: () => {
        bell = true;
      },
      title: (t) => {
        title = t;
      },
      cursor: (x, y) => {
        cursor = [Math.max(0, x | 0), Math.max(0, y | 0)];
      },
    };

    for (const ev of events) {
      if (exit !== undefined) break;
      const next = await this.def.update(this.state, ev, io);
      if (next !== undefined) this.state = next as S;
    }

    const node = await this.def.view(this.state, size, io);
    const screen = renderToScreen(node, size.cols, size.rows);
    if (cursor) screen.cursor = cursor;
    if (title) screen.title = title;
    if (bell) screen.bell = true;

    const out: StepResult = { frame: screen.toFrame() };
    if (wake !== undefined) out.wake = wake;
    if (exit !== undefined) out.exit = exit;
    return out;
  }
}
