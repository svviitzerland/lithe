import { ByteQueue, deriveSeed, hostKeyFromSeed, serveConnection, type HostKey } from "@lithe/ssh";
import type { AppDef, Env } from "../app.ts";
import { driveSshSession, type SshAppOptions } from "../ssh.ts";

/** The subset of WebSocket this needs, so Workers/Deno/Bun all fit. */
export interface WebSocketLike {
  send(data: ArrayBuffer | Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", cb: () => void): void;
}

export interface SshWsOptions<E extends object = Env> extends SshAppOptions<E> {
  /** Host key seed. **Set this**, or the fingerprint changes on every cold start. */
  seed?: string;
  label?: string;
  banner?: string;
  allowAnonymous?: boolean;
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  return new Uint8Array(0);
}

let cachedKey: { seed: string; key: Promise<HostKey> } | undefined;

/** Host keys are derived, not stored, and cached per isolate. */
export function sshHostKey(seed: string, label: string): Promise<HostKey> {
  const id = `${seed}\u0000${label}`;
  if (!cachedKey || cachedKey.seed !== id) {
    cachedKey = {
      seed: id,
      key: (seed
        ? deriveSeed(seed, label)
        : Promise.resolve(crypto.getRandomValues(new Uint8Array(32)))
      ).then(hostKeyFromSeed),
    };
  }
  return cachedKey.key;
}

/**
 * Speaks SSH over a WebSocket.
 *
 * This is what removes the relay. The SSH session is end-to-end between the
 * user's `ssh` client and your function, so anything in between — a public TCP
 * pipe, a `ProxyCommand` on the user's own machine — is carrying ciphertext it
 * cannot read and holds no key material. Nothing in the middle has to be
 * trusted, which is why nothing in the middle has to be set up.
 */
export async function attachSsh<S, E extends object = Env>(
  ws: WebSocketLike,
  def: AppDef<S, E>,
  opts: SshWsOptions<E> = {},
): Promise<void> {
  // The label is a constant by default: the fingerprint must track the seed,
  // not the app name, or renaming an app warns every client.
  const hostKey = await sshHostKey(opts.seed ?? "", opts.label ?? "lithe");
  const queue = new ByteQueue();

  ws.addEventListener("message", (ev) => queue.push(toBytes(ev.data)));
  ws.addEventListener("close", () => queue.end());
  ws.addEventListener("error", () => queue.end());

  await serveConnection(
    {
      write(data: Uint8Array) {
        // Copy: some runtimes keep a reference and our buffer is a subarray.
        ws.send(data.slice().buffer);
      },
      close() {
        try {
          ws.close(1000, "bye");
        } catch {
          /* already closed */
        }
      },
    },
    queue,
    {
      hostKey,
      ...(opts.banner ? { banner: opts.banner } : {}),
      ...(opts.allowAnonymous ? { allowAnonymous: true } : {}),
      onSession: (session) => driveSshSession(session, def, opts),
      onError: (err) => opts.onLog?.(`ssh: ${err.message}`),
    },
  );
}

export default attachSsh;
