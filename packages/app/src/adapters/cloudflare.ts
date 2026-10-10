import { createHandler, type HandlerOpts } from "../handler.ts";
import type { AppDef, Env } from "../app.ts";

/**
 * Cloudflare Workers. The Worker's `env` is passed straight through to the app,
 * so KV, D1, R2, Durable Object and secret bindings are available as `io.env`.
 *
 *   // src/index.ts
 *   import { cloudflare } from "@lithe/app/cloudflare";
 *   import app from "./app";
 *   export default cloudflare(app);
 */
export function cloudflare<S, E extends object = Env>(def: AppDef<S, E>, opts: HandlerOpts<E> = {}) {
  return {
    fetch(req: Request, env: E = {} as E): Promise<Response> {
      const bindings = env as E & { LITHE_SECRET?: string; LITHE_RELAY?: string };
      return createHandler(def, {
        ...opts,
        env: opts.env ?? env,
        secret: opts.secret ?? bindings.LITHE_SECRET,
        relay: opts.relay ?? bindings.LITHE_RELAY,
      })(req);
    },
  };
}

export default cloudflare;
