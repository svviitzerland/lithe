import { createHandler, type HandlerOpts } from "../handler.ts";
import type { AppDef, Env } from "../app.ts";

/** Bun.serve — also the origin used by `lithe serve` for local relay testing. */
export function serve<S, E extends object = Env>(def: AppDef<S, E>, opts: HandlerOpts<E> & { port?: number } = {}) {
  const handler = createHandler(def, opts);
  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  return Bun.serve({ port, fetch: handler });
}

export default serve;
