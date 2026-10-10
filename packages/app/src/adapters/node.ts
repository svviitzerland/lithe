import { createServer } from "node:http";
import { createHandler, type HandlerOpts } from "../handler.ts";
import { sendWebResponse, toWebRequest, type NodeRequestLike, type NodeResponseLike } from "../node-bridge.ts";
import type { AppDef, Env } from "../app.ts";

/** A plain Node HTTP server, for self-hosting or running behind any proxy. */
export function serve<S, E extends object = Env>(def: AppDef<S, E>, opts: HandlerOpts<E> & { port?: number } = {}) {
  const handler = createHandler(def, opts);
  const server = createServer((req, res) => {
    void toWebRequest(req as unknown as NodeRequestLike)
      .then(handler)
      .then((web) => sendWebResponse(res as unknown as NodeResponseLike, web))
      .catch(() => {
        res.statusCode = 500;
        res.end('{"error":"internal"}');
      });
  });
  server.listen(opts.port ?? Number(process.env.PORT ?? 8787));
  return server;
}

export default serve;
