import type { AppDef, Env } from "../app.ts";
import { attachSsh, type SshWsOptions, type WebSocketLike } from "./ssh-ws.ts";

/** The `ws`-style socket Node ecosystems hand you (Vercel, express+ws, etc.). */
export interface NodeStyleWebSocket {
  on(event: "message", cb: (data: unknown, isBinary?: boolean) => void): void;
  on(event: "close" | "error", cb: () => void): void;
  send(data: Uint8Array | ArrayBuffer | string): void;
  close(code?: number, reason?: string): void;
}

/** Presents an EventEmitter-style socket as the WebSocket this package expects. */
export function nodeWebSocketShim(ws: NodeStyleWebSocket): WebSocketLike {
  return {
    send: (data) => ws.send(data as Uint8Array),
    close: (code, reason) => ws.close(code, reason),
    addEventListener(type: string, cb: unknown) {
      if (type === "message") {
        ws.on("message", (data) => (cb as (ev: { data: unknown }) => void)({ data }));
      } else if (type === "close") {
        ws.on("close", cb as () => void);
      } else if (type === "error") {
        ws.on("error", cb as () => void);
      }
    },
  } as WebSocketLike;
}

export interface VercelSshOptions<E extends object = Env> extends SshWsOptions<E> {
  /**
   * `experimental_upgradeWebSocket` from `@vercel/functions`.
   *
   * Passed in rather than imported so this package carries no Vercel
   * dependency, and so the beta API can change under it without a release.
   */
  upgrade: (handler: (ws: NodeStyleWebSocket) => void | Promise<void>) => Response | Promise<Response>;
}

/**
 * SSH over a Vercel WebSocket, terminated inside the function.
 *
 *   // api/ssh.ts
 *   import { experimental_upgradeWebSocket } from "@vercel/functions";
 *   import { vercelSsh } from "@lithe/app/vercel-ssh";
 *   import app from "../app.ts";
 *
 *   export const GET = vercelSsh(app, {
 *     upgrade: experimental_upgradeWebSocket,
 *     seed: process.env.LITHE_SSH_SEED,
 *   });
 *
 * A Vercel function is killed at its maximum duration, so a long session ends
 * when the function does. Raise `maxDuration`, and expect `ssh` to exit rather
 * than hang when the ceiling is reached.
 */
export function vercelSsh<S, E extends object = Env>(def: AppDef<S, E>, opts: VercelSshOptions<E>) {
  return function handler(req?: Request): Promise<Response> {
    let app = opts.app;
    if (!app && req) {
      try {
        app = new URL(req.url).hostname;
      } catch {
        /* keep the default */
      }
    }
    return Promise.resolve(
      opts.upgrade((ws) => attachSsh(nodeWebSocketShim(ws), def, { ...opts, ...(app ? { app } : {}) })),
    );
  };
}

export default vercelSsh;
