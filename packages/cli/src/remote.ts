import type { Event, TuiRequest, TuiResponse } from "@lithe/app";
import { PROTOCOL_VERSION } from "@lithe/app";
import type { StepLike } from "./driver.ts";

/**
 * Drives an app over the wire protocol instead of in-process. Use it to verify
 * that a deployed endpoint behaves identically to local dev:
 *   lithe dev --remote https://my-app.vercel.app/api/tui
 */
export class RemoteRuntime implements StepLike {
  private url: string;
  private sid = crypto.randomUUID();
  private session: string | undefined;
  private user: string;

  constructor(url: string, user = "local") {
    this.url = url;
    this.user = user;
  }

  async init(): Promise<void> {
    /* the first POST carries the init event */
  }

  async step(events: Event[], size: { cols: number; rows: number }) {
    const body: TuiRequest = {
      v: PROTOCOL_VERSION,
      sid: this.sid,
      size: [size.cols, size.rows],
      events,
      ctx: { user: this.user, term: process.env.TERM ?? "xterm-256color", app: "local" },
      ...(this.session ? { session: this.session } : {}),
    };
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`origin returned ${res.status} ${res.statusText}`);
    const out = (await res.json()) as TuiResponse;
    this.session = out.session;
    return out;
  }
}
