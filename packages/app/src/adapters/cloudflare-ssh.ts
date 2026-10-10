import { createHandler, type HandlerOpts } from "../handler.ts";
import type { AppDef, Env } from "../app.ts";
import { attachSsh, sshHostKey, type SshWsOptions, type WebSocketLike } from "./ssh-ws.ts";

interface WorkersEnv {
  LITHE_SECRET?: string;
  LITHE_RELAY?: string;
  LITHE_SSH_SEED?: string;
}

interface WebSocketPairLike {
  0: WebSocketLike & { accept?(): void };
  1: WebSocketLike & { accept(): void };
}

declare const WebSocketPair: { new (): WebSocketPairLike };

export interface CloudflareSshOptions<E extends object = Env> extends HandlerOpts<E> {
  ssh?: Omit<SshWsOptions<E>, "env">;
  /** path the ssh client connects to (default "/_lithe/ssh"); any path with an Upgrade header also works */
  path?: string;
}

/**
 * A Worker that is both an HTTP endpoint and an SSH server.
 *
 *   import { cloudflareSsh } from "@lithe/app/cloudflare-ssh";
 *   import app from "./app";
 *   export default cloudflareSsh(app);
 *
 * - `GET /` returns the manifest, so relays can still discover it.
 * - `POST /` runs the stateless frame protocol, for relay-based access.
 * - `GET /_lithe/ssh` with `Upgrade: websocket` carries a complete SSH session,
 *   terminated inside this Worker. Nothing between the user and the function can
 *   read it.
 *
 * Set `LITHE_SSH_SEED` as a secret. It is the host key: same seed, same
 * fingerprint, so clients never see a host-key warning.
 */
export function cloudflareSsh<S, E extends object = Env>(
  def: AppDef<S, E>,
  opts: CloudflareSshOptions<E> = {},
) {
  return {
    async fetch(req: Request, env: E & WorkersEnv = {} as E & WorkersEnv): Promise<Response> {
      const upgrade = req.headers.get("upgrade");
      if (upgrade && upgrade.toLowerCase() === "websocket") {
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        server.accept();
        // Deliberately not awaited: the response must go out now so the client
        // can start the SSH handshake.
        void attachSsh(server, def, {
          ...opts.ssh,
          env: (opts.env ?? env) as E,
          app: opts.ssh?.app ?? hostOf(req),
          seed: opts.ssh?.seed ?? env.LITHE_SSH_SEED ?? env.LITHE_SECRET ?? "",
        }).catch(() => {
          /* the session reports its own errors */
        });
        return new Response(null, { status: 101, webSocket: client } as ResponseInit & {
          webSocket: unknown;
        });
      }

      return createHandler(def, {
        ...opts,
        env: (opts.env ?? env) as E,
        secret: opts.secret ?? env.LITHE_SECRET,
        relay: opts.relay ?? env.LITHE_RELAY,
      })(req);
    },
  };
}

function hostOf(req: Request): string {
  try {
    return new URL(req.url).hostname;
  } catch {
    return "lithe";
  }
}

/** The host key fingerprint this deployment will present, for publishing. */
export function fingerprintFor(seed: string, label = "lithe"): Promise<string> {
  return sshHostKey(seed, label).then((k) => k.fingerprint);
}

export default cloudflareSsh;
