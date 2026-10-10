/**
 * Bridges Node's `(req, res)` calling convention onto the portable
 * `Request -> Response` handler.
 *
 * Deliberately structural: this file imports nothing, so adapters that must run
 * on an edge runtime can reference it without dragging in `node:http`.
 */

export interface NodeRequestLike {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array | string>;
}

export interface NodeResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk?: Uint8Array | string): void;
}

/** True when this looks like a Node server response object. */
export function isNodeResponse(x: unknown): x is NodeResponseLike {
  return typeof x === "object" && x !== null && typeof (x as NodeResponseLike).setHeader === "function";
}

export async function toWebRequest(req: NodeRequestLike): Promise<Request> {
  const method = req.method ?? "GET";
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(", "));
  }
  const host = headers.get("host") ?? "localhost";
  const proto = headers.get("x-forwarded-proto") ?? "http";
  const url = new URL(req.url ?? "/", `${proto}://${host}`);

  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const c of req) {
    const bytes = typeof c === "string" ? new TextEncoder().encode(c) : c;
    chunks.push(bytes);
    total += bytes.byteLength;
  }
  const body = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    body.set(c, off);
    off += c.byteLength;
  }
  return new Request(url, { method, headers, body });
}

export async function sendWebResponse(res: NodeResponseLike, web: Response): Promise<void> {
  res.statusCode = web.status;
  web.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(new Uint8Array(await web.arrayBuffer()));
}
