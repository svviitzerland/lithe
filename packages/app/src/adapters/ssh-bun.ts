import { ByteQueue, deriveSeed, hostKeyFromSeed, serveConnection, type Duplex } from "@lithe/ssh";
import type { AppDef, Env } from "../app.ts";
import { driveSshSession, type SshAppOptions } from "../ssh.ts";

export interface ListenSshOptions<E extends object = Env> extends SshAppOptions<E> {
  port?: number;
  hostname?: string;
  /** Host key seed. Same seed, same fingerprint, forever. */
  seed?: string;
  /**
   * Label mixed into the host key derivation. Defaults to a constant so the
   * fingerprint depends on the seed alone — renaming the app must not make
   * every client print a host-key warning.
   */
  label?: string;
  banner?: string;
}

interface SocketState {
  queue: ByteQueue;
  pending: Uint8Array[];
}

/**
 * Serves an app over SSH on a real TCP port, using Bun's socket API.
 *
 * Useful for two things: proving the pure-TypeScript SSH server against a stock
 * `ssh` client, and self-hosting without the Go relay — `bun run ssh.ts` is a
 * complete SSH app server.
 */
export async function listenSsh<S, E extends object = Env>(
  def: AppDef<S, E>,
  opts: ListenSshOptions<E> = {},
) {
  const seed = opts.seed ?? process.env.LITHE_SEED ?? "";
  const label = opts.label ?? "lithe";
  const hostKey = await hostKeyFromSeed(
    seed ? await deriveSeed(seed, label) : crypto.getRandomValues(new Uint8Array(32)),
  );

  const server = Bun.listen<SocketState>({
    hostname: opts.hostname ?? "0.0.0.0",
    port: opts.port ?? 2222,
    socket: {
      open(socket) {
        const state: SocketState = { queue: new ByteQueue(), pending: [] };
        socket.data = state;

        const stream: Duplex = {
          write(data: Uint8Array) {
            // Bun may accept only part of a write; keep the rest for drain().
            if (state.pending.length > 0) {
              state.pending.push(data);
              return;
            }
            const n = socket.write(data);
            if (n < data.byteLength) state.pending.push(data.subarray(n));
          },
          close() {
            socket.end();
          },
        };

        void serveConnection(stream, state.queue, {
          hostKey,
          ...(opts.banner ? { banner: opts.banner } : {}),
          onSession: (session) => driveSshSession(session, def, opts),
          onError: (err) => opts.onLog?.(`ssh: ${err.message}`),
        });
      },
      data(socket, buffer) {
        socket.data.queue.push(new Uint8Array(buffer));
      },
      drain(socket) {
        const state = socket.data;
        while (state.pending.length > 0) {
          const head = state.pending[0]!;
          const n = socket.write(head);
          if (n < head.byteLength) {
            state.pending[0] = head.subarray(n);
            return;
          }
          state.pending.shift();
        }
      },
      close(socket) {
        socket.data.queue.end();
      },
      error(socket, error) {
        socket.data.queue.end(error);
      },
    },
  });

  return { server, fingerprint: hostKey.fingerprint };
}

export default listenSsh;
