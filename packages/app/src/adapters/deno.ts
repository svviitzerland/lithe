import { createHandler, type HandlerOpts } from "../handler.ts";
import type { AppDef, Env } from "../app.ts";

/** Deno Deploy / `deno serve`. */
export function deno<S, E extends object = Env>(def: AppDef<S, E>, opts: HandlerOpts<E> = {}) {
  return { fetch: createHandler(def, opts) };
}

export default deno;
