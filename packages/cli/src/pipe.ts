/**
 * The client half of the relay-less path.
 *
 * `ssh` needs a byte stream; a serverless function offers HTTPS. This bridges
 * the two on the user's own machine, so no server in the middle exists at all:
 *
 *   ssh -o ProxyCommand="lithe pipe %h" user@my-app.vercel.app
 *
 * The SSH session is end-to-end encrypted between the local `ssh` client and the
 * function, so this process is carrying ciphertext it cannot read either.
 */
export interface PipeOptions {
  host: string;
  path?: string;
  insecure?: boolean;
  port?: number;
}

export function pipeToWebSocket(opts: PipeOptions): Promise<number> {
  const scheme = opts.insecure ? "ws" : "wss";
  const port = opts.port ? `:${opts.port}` : "";
  const path = opts.path ?? "/_lithe/ssh";
  const url = `${scheme}://${opts.host}${port}${path}`;

  return new Promise<number>((resolve) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    const backlog: Uint8Array[] = [];
    let open = false;
    let finished = false;

    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve(code);
    };

    ws.onopen = () => {
      open = true;
      for (const b of backlog) ws.send(b);
      backlog.length = 0;
    };

    ws.onmessage = (ev: MessageEvent) => {
      const data = ev.data;
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : typeof data === "string"
            ? new TextEncoder().encode(data)
            : new Uint8Array(0);
      if (bytes.byteLength > 0) process.stdout.write(bytes);
    };

    ws.onerror = () => {
      process.stderr.write(`lithe: cannot reach ${url}\n`);
      finish(1);
    };

    ws.onclose = () => finish(0);

    process.stdin.on("data", (chunk: Buffer) => {
      const bytes = new Uint8Array(chunk);
      if (open) ws.send(bytes);
      else backlog.push(bytes);
    });
    process.stdin.on("end", () => finish(0));
    process.stdin.resume();
  });
}

export interface SshArgsOptions {
  insecure?: boolean;
  /** port of the HTTPS endpoint; omitted means 443, which is the normal case */
  wsPort?: number;
  path?: string;
}

/** Builds the `ssh` argv that routes a connection through `lithe pipe`. */
export function sshArgs(host: string, self: string, extra: string[] = [], opts: SshArgsOptions = {}): string[] {
  const flags = [
    opts.insecure ? " --insecure" : "",
    opts.wsPort ? ` --port ${opts.wsPort}` : "",
    opts.path ? ` --path ${opts.path}` : "",
  ].join("");
  const proxy = `${self} pipe %h${flags}`;
  return [
    "-o",
    `ProxyCommand=${proxy}`,
    // The host key is pinned by its fingerprint, which the deployment publishes;
    // accept-new keeps first contact quiet without blindly trusting changes.
    "-o",
    "StrictHostKeyChecking=accept-new",
    ...extra,
    host,
  ];
}
