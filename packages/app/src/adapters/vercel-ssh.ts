import type { AppDef, Env } from "../app.ts";
import { createHandler, type HandlerOpts } from "../handler.ts";
import { isNodeResponse, sendWebResponse, toWebRequest, type NodeRequestLike } from "../node-bridge.ts";
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

export interface VercelSshOptions<E extends object = Env> extends SshWsOptions<E>, HandlerOpts<E> {
  /**
   * `experimental_upgradeWebSocket` from `@vercel/functions`.
   *
   * Passed in rather than imported so this package carries no Vercel
   * dependency, and so the beta API can change under it without a release.
   */
  upgrade: (handler: (ws: NodeStyleWebSocket) => void | Promise<void>) => Response | Promise<Response>;
}

/**
 * One Vercel Function that answers both ways, so an app is still a single file.
 *
 *   // api/tui.ts
 *   import { experimental_upgradeWebSocket } from "@vercel/functions";
 *   import { vercelSsh } from "@lithe/app/vercel-ssh";
 *   import app from "../app.ts";
 *
 *   const handler = vercelSsh(app, { upgrade: experimental_upgradeWebSocket });
 *   export const GET = handler;
 *   export const POST = handler;
 *   export default handler;
 *
 * With an `Upgrade: websocket` header it carries a whole SSH session; otherwise
 * it serves the manifest and the stateless frame protocol.
 *
 * A Vercel function is killed at its maximum duration, so a long session ends
 * when the function does. Raise `maxDuration`, and expect `ssh` to exit rather
 * than hang when the ceiling is reached.
 */
export function vercelSsh<S, E extends object = Env>(def: AppDef<S, E>, opts: VercelSshOptions<E>) {
  const http = createHandler(def, opts);

  return async function handler(
    req: Request | NodeRequestLike,
    res?: unknown,
  ): Promise<Response | void> {
    const request = res !== undefined && isNodeResponse(res) ? await toWebRequest(req as NodeRequestLike) : (req as Request);

    const upgrade = request.headers?.get?.("upgrade");
    if (upgrade && upgrade.toLowerCase() === "websocket") {
      let app = opts.app;
      try {
        app = app ?? new URL(request.url).hostname;
      } catch {
        /* keep the default */
      }
      return opts.upgrade((ws) =>
        attachSsh(nodeWebSocketShim(ws), def, { ...opts, ...(app ? { app } : {}) }),
      );
    }

    const out = await http(request);
    if (res !== undefined && isNodeResponse(res)) {
      await sendWebResponse(res, out);
      return;
    }
    return out;
  };
}

export default vercelSsh;
