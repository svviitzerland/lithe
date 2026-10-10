import type { AppDef, Env } from "../app.ts";
import { createHandler, type HandlerOpts } from "../handler.ts";
import { attachSsh, type SshWsOptions, type WebSocketLike } from "./ssh-ws.ts";

interface Listeners {
  message: ((ev: { data: unknown }) => void)[];
  close: (() => void)[];
  error: (() => void)[];
}

interface SocketData {
  listeners: Listeners;
}

/**
 * Bun.serve, speaking both HTTP and SSH-over-WebSocket. Bun's socket uses
 * callbacks rather than events, so this shim presents it as a WebSocket.
 *
 *   const { fetch, websocket } = bunSsh(app, { seed: process.env.LITHE_SSH_SEED });
 *   Bun.serve({ port: 8787, fetch, websocket });
 */
export function bunSsh<S, E extends object = Env>(
  def: AppDef<S, E>,
  opts: HandlerOpts<E> & { ssh?: Omit<SshWsOptions<E>, "env"> } = {},
) {
  const http = createHandler(def, opts);

  return {
    fetch(req: Request, server: { upgrade(req: Request, o?: { data: SocketData }): boolean }) {
      const upgrade = req.headers.get("upgrade");
      if (upgrade && upgrade.toLowerCase() === "websocket") {
        const data: SocketData = { listeners: { message: [], close: [], error: [] } };
        if (server.upgrade(req, { data })) return undefined;
        return new Response("websocket upgrade failed", { status: 400 });
      }
      return http(req);
    },

    websocket: {
      open(ws: { data: SocketData; send(d: ArrayBuffer | Uint8Array | string): number; close(c?: number, r?: string): void }) {
        const { listeners } = ws.data;
        const shim: WebSocketLike = {
          send: (d) => void ws.send(d),
          close: (c, r) => ws.close(c, r),
          addEventListener(type: string, cb: unknown) {
            if (type === "message") listeners.message.push(cb as (ev: { data: unknown }) => void);
            else if (type === "close") listeners.close.push(cb as () => void);
            else if (type === "error") listeners.error.push(cb as () => void);
          },
        } as WebSocketLike;
        void attachSsh(shim, def, { ...opts.ssh, env: opts.env as E }).catch(() => {
          /* the session reports its own errors */
        });
      },
      message(ws: { data: SocketData }, message: string | Uint8Array) {
        for (const cb of ws.data.listeners.message) cb({ data: message });
      },
      close(ws: { data: SocketData }) {
        for (const cb of ws.data.listeners.close) cb();
      },
    },
  };
}

export default bunSsh;
