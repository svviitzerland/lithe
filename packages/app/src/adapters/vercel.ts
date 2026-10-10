import { createHandler, type HandlerOpts } from "../handler.ts";
import { isNodeResponse, sendWebResponse, toWebRequest, type NodeRequestLike } from "../node-bridge.ts";
import type { AppDef, Env } from "../app.ts";

/**
 * Vercel Functions.
 *
 *   // api/tui.ts
 *   import { vercel } from "@lithe/app/vercel";
 *   import app from "../app.ts";
 *   export const GET = vercel(app);
 *   export const POST = GET;
 *   export default GET;
 *
 * The returned function accepts either calling convention — a Web `Request`
 * (Edge runtime, Next route handlers) or Node's `(req, res)` — because which one
 * you get depends on the runtime and on how the function was authored. Sniffing
 * the second argument is more reliable than asking people to pick an import.
 */
export function vercel<S, E extends object = Env>(def: AppDef<S, E>, opts: HandlerOpts<E> = {}) {
  const web = createHandler(def, opts);

  return async function handler(req: Request | NodeRequestLike, res?: unknown): Promise<Response | void> {
    if (res !== undefined && isNodeResponse(res)) {
      const request = await toWebRequest(req as NodeRequestLike);
      await sendWebResponse(res, await web(request));
      return;
    }
    return web(req as Request);
  };
}

export default vercel;
