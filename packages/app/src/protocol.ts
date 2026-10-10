import type { Frame } from "@lithe/core";

export const PROTOCOL_VERSION = 1;

/** Who is connected. Populated by the relay from the SSH handshake. */
export interface ClientCtx {
  /** SSH username, or "anon" */
  user: string;
  /** client public key fingerprint, e.g. "SHA256:abc..." — a stable per-user id */
  pubkey?: string;
  ip?: string;
  term?: string;
  /** app id the relay resolved this connection to */
  app?: string;
  /** relay-reported client locale/charset hints */
  lang?: string;
}

export type Event =
  | { t: "init" }
  | { t: "key"; key: string; rune?: string }
  | { t: "paste"; data: string }
  | { t: "resize"; cols: number; rows: number }
  | { t: "tick" }
  | { t: "close" };

/** One batch of input. Sent by the relay for every coalesced frame of activity. */
export interface TuiRequest {
  v: number;
  /** session id, stable for the life of one SSH connection */
  sid: string;
  /** opaque state blob the relay holds on the app's behalf; absent on the first call */
  session?: string;
  size: [cols: number, rows: number];
  events: Event[];
  ctx: ClientCtx;
  /** opaque view-diff state, echoed from the previous response */
  vst?: string;
  /** ask for a complete frame: the caller has nothing to diff against */
  full?: boolean;
}

export interface TuiResponse {
  v: number;
  /** opaque state to send back with the next request */
  session?: string;
  frame?: Frame;
  /** opaque view-diff state to echo back on the next request */
  vst?: string;
  /** the frame carries only changed rows */
  partial?: boolean;
  /** ask the relay to send a `tick` event after this many ms */
  wake?: number;
  /** non-null closes the SSH session with this exit status */
  exit?: number | null;
  /** written to the client's stderr before closing */
  err?: string;
}

/** `GET /` on an app endpoint returns this, so relays and humans can discover it. */
export interface Manifest {
  lithe: number;
  name: string;
  /** supported transports */
  modes: ("stateless" | "ws")[];
  description?: string;
  /** suggested connect string shown to humans */
  connect?: string;
}
