import { Reader, Writer, concat } from "./buffer.ts";
import {
  SUPPORTED_SIG_ALGS,
  keyFingerprint,
  sha256,
  verifyClientSignature,
  x25519Ephemeral,
  type HostKey,
} from "./crypto.ts";
import { ByteQueue, DISCONNECT_BY_APPLICATION, MSG, PacketTransport, type Duplex } from "./transport.ts";

const enc = (s: string) => new TextEncoder().encode(s);

/** What the client offered when authenticating. */
export interface AuthAttempt {
  user: string;
  method: "none" | "publickey" | "keyboard-interactive";
  /** present for publickey; "SHA256:…" */
  fingerprint?: string;
  keyAlgo?: string;
  /** true when the signature checked out cryptographically */
  verified: boolean;
}

export interface SessionInfo {
  user: string;
  /** stable client identity, when a key was offered */
  fingerprint?: string;
  term: string;
  cols: number;
  rows: number;
  /** set when the client ran `ssh host some-command` instead of a shell */
  command?: string;
}

export interface SshSession {
  readonly info: SessionInfo;
  write(data: Uint8Array | string): Promise<void>;
  onData(cb: (data: Uint8Array) => void): void;
  onResize(cb: (cols: number, rows: number) => void): void;
  onClose(cb: () => void): void;
  exit(code?: number): Promise<void>;
}

export interface SshServerOptions {
  hostKey: HostKey;
  serverVersion?: string;
  /** shown by the client before authentication */
  banner?: string;
  /**
   * Decide whether to let the client in.
   *
   * The default refuses the "none" method so the client goes on to offer its
   * public key, which the app then gets as a stable user id. Clients with no key
   * at all fall through to keyboard-interactive and are let in anonymously. Set
   * `allowAnonymous` to skip straight to success.
   */
  authenticate?(attempt: AuthAttempt): boolean | Promise<boolean>;
  /** accept the "none" method immediately, giving up the key fingerprint */
  allowAnonymous?: boolean;
  /** Called once a pty-backed shell (or exec) is ready. */
  onSession(session: SshSession): void | Promise<void>;
  onError?(err: Error): void;
}

const KEX_ALGS = ["curve25519-sha256", "curve25519-sha256@libssh.org", "kex-strict-s-v00@openssh.com"];
const HOST_KEY_ALGS = ["ssh-ed25519"];
const CIPHERS = ["aes256-gcm@openssh.com", "aes128-gcm@openssh.com"];
// Ignored with an AEAD cipher, but the field must not be empty.
const MACS = ["hmac-sha2-256"];
const COMPRESSION = ["none"];

const LOCAL_WINDOW = 1 << 21;
const LOCAL_MAX_PACKET = 32 * 1024;

/**
 * Serves one SSH connection, start to finish, in pure TypeScript.
 *
 * Why this exists: if the serverless function itself speaks SSH, then nothing in
 * the middle needs to be trusted. A relay becomes a dumb byte pipe that cannot
 * read the session, cannot forge app state, and holds no keys — so it can be run
 * by anyone, or replaced by a client-side `ProxyCommand`, or dropped entirely on
 * a platform that hands a Worker a raw socket.
 */
export async function serveConnection(
  stream: Duplex,
  queue: ByteQueue,
  opts: SshServerOptions,
): Promise<void> {
  const serverVersion = opts.serverVersion ?? "SSH-2.0-lithe_0.1";
  const t = new PacketTransport(stream, queue);

  try {
    // ---- version exchange (RFC 4253 §4.2) --------------------------------
    await stream.write(enc(`${serverVersion}\r\n`));
    let clientVersion = "";
    for (let i = 0; i < 64; i++) {
      const line = await queue.readLine(255);
      if (line.startsWith("SSH-")) {
        clientVersion = line;
        break;
      }
      // Pre-banner lines are allowed and must be ignored.
    }
    if (!clientVersion.startsWith("SSH-2.0") && !clientVersion.startsWith("SSH-1.99")) {
      throw new Error(`ssh: unsupported client version ${JSON.stringify(clientVersion)}`);
    }

    // ---- key exchange ----------------------------------------------------
    const serverKexInit = buildKexInit();
    await t.send(serverKexInit);

    let clientKexInit: Uint8Array | undefined;
    for (let i = 0; i < 8 && !clientKexInit; i++) {
      const p = await t.receive();
      if (p[0] === MSG.KEXINIT) clientKexInit = p;
      else if (p[0] !== MSG.IGNORE && p[0] !== MSG.DEBUG) {
        throw new Error(`ssh: expected KEXINIT, got message ${p[0]}`);
      }
    }
    if (!clientKexInit) throw new Error("ssh: no KEXINIT from client");

    const offer = parseKexInit(clientKexInit);
    t.strictKex = offer.kex.includes("kex-strict-c-v00@openssh.com");
    const wantsExtInfo = offer.kex.includes("ext-info-c");

    const kexAlg = pick(offer.kex, KEX_ALGS);
    const hostKeyAlg = pick(offer.hostKey, HOST_KEY_ALGS);
    const cipherC2S = pick(offer.cipherC2S, CIPHERS);
    const cipherS2C = pick(offer.cipherS2C, CIPHERS);
    if (!kexAlg || !hostKeyAlg || !cipherC2S || !cipherS2C) {
      await disconnect(t, "no matching algorithm: need curve25519-sha256, ssh-ed25519 and an AES-GCM cipher");
      return;
    }

    let ecdhInit: Uint8Array | undefined;
    for (let i = 0; i < 8 && !ecdhInit; i++) {
      const p = await t.receive();
      if (p[0] === MSG.KEX_ECDH_INIT) ecdhInit = p;
      else if (p[0] !== MSG.IGNORE && p[0] !== MSG.DEBUG) {
        throw new Error(`ssh: expected KEX_ECDH_INIT, got ${p[0]}`);
      }
    }
    if (!ecdhInit) throw new Error("ssh: no KEX_ECDH_INIT");

    const qc = new Reader(ecdhInit.subarray(1)).string();
    if (qc.byteLength !== 32) throw new Error("ssh: bad client key share");

    const eph = await x25519Ephemeral();
    const shared = await eph.derive(qc);
    const kEncoded = new Writer().mpint(shared).done();

    // The exchange hash binds the versions, both KEXINIT payloads, the host key
    // and both key shares. Signing it is what proves we hold the host key.
    const h = await sha256(
      new Writer()
        .string(clientVersion)
        .string(serverVersion)
        .string(clientKexInit)
        .string(serverKexInit)
        .string(opts.hostKey.blob)
        .string(qc)
        .string(eph.publicKey)
        .raw(kEncoded)
        .done(),
    );
    const signature = await opts.hostKey.sign(h);

    await t.send(
      new Writer()
        .byte(MSG.KEX_ECDH_REPLY)
        .string(opts.hostKey.blob)
        .string(eph.publicKey)
        .string(signature)
        .done(),
    );

    const sessionId = h;
    const keyBits = cipherS2C.startsWith("aes256") ? 32 : 16;
    const derive = async (letter: string, n: number): Promise<Uint8Array> => {
      let out = await sha256(kEncoded, h, enc(letter), sessionId);
      while (out.byteLength < n) out = concat(out, await sha256(kEncoded, h, out));
      return out.subarray(0, n);
    };
    const ivC2S = await derive("A", 12);
    const ivS2C = await derive("B", 12);
    const keyC2S = await derive("C", cipherC2S.startsWith("aes256") ? 32 : 16);
    const keyS2C = await derive("D", keyBits);

    await t.send(new Uint8Array([MSG.NEWKEYS]));
    await t.enableOut(keyS2C, ivS2C);

    const theirNewKeys = await t.receive();
    if (theirNewKeys[0] !== MSG.NEWKEYS) throw new Error("ssh: expected NEWKEYS");
    await t.enableIn(keyC2S, ivC2S);

    if (wantsExtInfo) {
      await t.send(
        new Writer()
          .byte(MSG.EXT_INFO)
          .uint32(1)
          .string("server-sig-algs")
          .string(SUPPORTED_SIG_ALGS.join(","))
          .done(),
      );
    }

    // ---- authentication --------------------------------------------------
    const auth = await authenticate(t, sessionId, opts);
    if (!auth) return;

    // ---- the session channel --------------------------------------------
    await runConnection(t, auth, opts);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    opts.onError?.(e);
    try {
      t.close();
    } catch {
      /* already gone */
    }
  }
}

function buildKexInit(): Uint8Array {
  return new Writer()
    .byte(MSG.KEXINIT)
    .raw(crypto.getRandomValues(new Uint8Array(16)))
    .nameList(KEX_ALGS)
    .nameList(HOST_KEY_ALGS)
    .nameList(CIPHERS)
    .nameList(CIPHERS)
    .nameList(MACS)
    .nameList(MACS)
    .nameList(COMPRESSION)
    .nameList(COMPRESSION)
    .nameList([])
    .nameList([])
    .bool(false)
    .uint32(0)
    .done();
}

interface KexOffer {
  kex: string[];
  hostKey: string[];
  cipherC2S: string[];
  cipherS2C: string[];
}

function parseKexInit(p: Uint8Array): KexOffer {
  const r = new Reader(p.subarray(1));
  r.bytes(16);
  return {
    kex: r.nameList(),
    hostKey: r.nameList(),
    cipherC2S: r.nameList(),
    cipherS2C: r.nameList(),
  };
}

/** The client's preference order wins, per RFC 4253 §7.1. */
function pick(clientList: string[], ours: string[]): string | undefined {
  return clientList.find((c) => ours.includes(c));
}

async function disconnect(t: PacketTransport, why: string): Promise<void> {
  try {
    await t.send(
      new Writer()
        .byte(MSG.DISCONNECT)
        .uint32(DISCONNECT_BY_APPLICATION)
        .string(why)
        .string("")
        .done(),
    );
  } catch {
    /* best effort */
  }
  t.close();
}

interface Authenticated {
  user: string;
  fingerprint?: string;
}

async function authenticate(
  t: PacketTransport,
  sessionId: Uint8Array,
  opts: SshServerOptions,
): Promise<Authenticated | undefined> {
  // Refusing "none" is what makes OpenSSH offer a key, and the key is the
  // identity. Without this every user is anonymous.
  const allow =
    opts.authenticate ?? ((a: AuthAttempt) => (a.method === "none" ? opts.allowAnonymous === true : true));
  let bannerSent = false;

  for (let i = 0; i < 64; i++) {
    const p = await t.receive();
    const msg = p[0];

    if (msg === MSG.SERVICE_REQUEST) {
      const name = new Reader(p.subarray(1)).text();
      if (name !== "ssh-userauth") {
        await disconnect(t, `unsupported service ${name}`);
        return undefined;
      }
      await t.send(new Writer().byte(MSG.SERVICE_ACCEPT).string(name).done());
      if (opts.banner && !bannerSent) {
        bannerSent = true;
        await t.send(new Writer().byte(MSG.USERAUTH_BANNER).string(opts.banner).string("").done());
      }
      continue;
    }

    if (msg === MSG.IGNORE || msg === MSG.DEBUG) continue;

    if (msg !== MSG.USERAUTH_REQUEST) {
      if (msg === MSG.USERAUTH_INFO_RESPONSE) continue;
      await t.send(new Writer().byte(MSG.UNIMPLEMENTED).uint32(t.sequenceIn).done());
      continue;
    }

    const r = new Reader(p.subarray(1));
    const user = r.text();
    const service = r.text();
    const method = r.text();

    if (method === "none") {
      if (await allow({ user, method: "none", verified: false })) {
        await t.send(new Uint8Array([MSG.USERAUTH_SUCCESS]));
        return { user };
      }
      await failAuth(t);
      continue;
    }

    if (method === "keyboard-interactive") {
      // No prompts: a public app has nothing to ask. This is the path for
      // clients that offered no key at all.
      await t.send(
        new Writer()
          .byte(MSG.USERAUTH_INFO_REQUEST)
          .string("")
          .string("")
          .string("")
          .uint32(0)
          .done(),
      );
      const resp = await t.receive();
      if (resp[0] === MSG.USERAUTH_INFO_RESPONSE) {
        if (await allow({ user, method: "keyboard-interactive", verified: false })) {
          await t.send(new Uint8Array([MSG.USERAUTH_SUCCESS]));
          return { user };
        }
      }
      await failAuth(t);
      continue;
    }

    if (method === "publickey") {
      const hasSig = r.bool();
      const algo = r.text();
      const keyBlob = r.string();

      if (!hasSig) {
        // Probe: tell the client this key is worth signing with.
        await t.send(new Writer().byte(MSG.USERAUTH_PK_OK).string(algo).string(keyBlob).done());
        continue;
      }

      const sigBlob = r.string();
      const sigReader = new Reader(sigBlob);
      const sigAlgo = sigReader.text();
      const sigBytes = sigReader.string();

      // Exactly the bytes the client signed (RFC 4252 §7).
      const signed = new Writer()
        .string(sessionId)
        .byte(MSG.USERAUTH_REQUEST)
        .string(user)
        .string(service)
        .string("publickey")
        .bool(true)
        .string(algo)
        .string(keyBlob)
        .done();

      const verified =
        sigAlgo === algo && (await verifyClientSignature(algo, keyBlob, sigBytes, signed));
      const fingerprint = await keyFingerprint(keyBlob);

      if (verified && (await allow({ user, method: "publickey", fingerprint, keyAlgo: algo, verified }))) {
        await t.send(new Uint8Array([MSG.USERAUTH_SUCCESS]));
        return { user, fingerprint };
      }
      await failAuth(t);
      continue;
    }

    await failAuth(t);
  }

  await disconnect(t, "too many authentication attempts");
  return undefined;
}

function failAuth(t: PacketTransport): Promise<void> {
  return t.send(
    new Writer()
      .byte(MSG.USERAUTH_FAILURE)
      .nameList(["publickey", "keyboard-interactive", "none"])
      .bool(false)
      .done(),
  );
}

async function runConnection(
  t: PacketTransport,
  auth: Authenticated,
  opts: SshServerOptions,
): Promise<void> {
  let localId = 0;
  let remoteId = -1;
  let remoteWindow = 0;
  let remoteMaxPacket = 32768;
  let consumed = 0;
  let started = false;
  let closed = false;

  const info: SessionInfo = { user: auth.user, term: "xterm-256color", cols: 80, rows: 24 };
  if (auth.fingerprint) info.fingerprint = auth.fingerprint;

  const dataCbs: ((d: Uint8Array) => void)[] = [];
  const resizeCbs: ((c: number, r: number) => void)[] = [];
  const closeCbs: (() => void)[] = [];

  let windowWaiter: (() => void) | undefined;
  const waitForWindow = () =>
    new Promise<void>((resolve) => {
      windowWaiter = resolve;
    });

  const session: SshSession = {
    info,
    async write(data: Uint8Array | string): Promise<void> {
      if (closed || remoteId < 0) return;
      let buf = typeof data === "string" ? enc(data) : data;
      while (buf.byteLength > 0) {
        if (remoteWindow <= 0) {
          await waitForWindow();
          if (closed) return;
          continue;
        }
        const n = Math.min(buf.byteLength, remoteWindow, remoteMaxPacket);
        const chunk = buf.subarray(0, n);
        buf = buf.subarray(n);
        remoteWindow -= n;
        await t.send(new Writer().byte(MSG.CHANNEL_DATA).uint32(remoteId).string(chunk).done());
      }
    },
    onData: (cb) => void dataCbs.push(cb),
    onResize: (cb) => void resizeCbs.push(cb),
    onClose: (cb) => void closeCbs.push(cb),
    async exit(code = 0): Promise<void> {
      if (closed || remoteId < 0) return;
      closed = true;
      await t.send(
        new Writer()
          .byte(MSG.CHANNEL_REQUEST)
          .uint32(remoteId)
          .string("exit-status")
          .bool(false)
          .uint32(code)
          .done(),
      );
      await t.send(new Writer().byte(MSG.CHANNEL_EOF).uint32(remoteId).done());
      await t.send(new Writer().byte(MSG.CHANNEL_CLOSE).uint32(remoteId).done());
      // No DISCONNECT: a server-initiated disconnect makes ssh exit 255 even
      // after a clean exit-status. The read loop closes when the client
      // acknowledges with its own CHANNEL_CLOSE.
    },
  };

  while (true) {
    let p: Uint8Array;
    try {
      p = await t.receive();
    } catch {
      break; // peer went away
    }
    const msg = p[0];
    const r = new Reader(p.subarray(1));

    switch (msg) {
      case MSG.IGNORE:
      case MSG.DEBUG:
        break;

      case MSG.GLOBAL_REQUEST: {
        r.text();
        if (r.bool()) await t.send(new Uint8Array([MSG.REQUEST_FAILURE]));
        break;
      }

      case MSG.CHANNEL_OPEN: {
        const type = r.text();
        const sender = r.uint32();
        const window = r.uint32();
        const maxPacket = r.uint32();
        if (type !== "session" || remoteId >= 0) {
          await t.send(
            new Writer()
              .byte(MSG.CHANNEL_OPEN_FAILURE)
              .uint32(sender)
              .uint32(1) // administratively prohibited
              .string(remoteId >= 0 ? "one session per connection" : `unsupported channel ${type}`)
              .string("")
              .done(),
          );
          break;
        }
        remoteId = sender;
        remoteWindow = window;
        remoteMaxPacket = Math.max(1024, Math.min(maxPacket, LOCAL_MAX_PACKET));
        await t.send(
          new Writer()
            .byte(MSG.CHANNEL_OPEN_CONFIRMATION)
            .uint32(remoteId)
            .uint32(localId)
            .uint32(LOCAL_WINDOW)
            .uint32(LOCAL_MAX_PACKET)
            .done(),
        );
        break;
      }

      case MSG.CHANNEL_REQUEST: {
        r.uint32();
        const type = r.text();
        const wantReply = r.bool();
        let ok = false;

        if (type === "pty-req") {
          info.term = new TextDecoder().decode(r.string()) || "xterm-256color";
          const cols = r.uint32();
          const rows = r.uint32();
          if (cols > 0) info.cols = Math.min(cols, 500);
          if (rows > 0) info.rows = Math.min(rows, 200);
          ok = true;
        } else if (type === "window-change") {
          const cols = r.uint32();
          const rows = r.uint32();
          if (cols > 0) info.cols = Math.min(cols, 500);
          if (rows > 0) info.rows = Math.min(rows, 200);
          for (const cb of resizeCbs) cb(info.cols, info.rows);
          ok = true;
        } else if (type === "shell" || type === "exec") {
          if (type === "exec") info.command = r.text();
          ok = true;
          if (wantReply) {
            await t.send(new Writer().byte(MSG.CHANNEL_SUCCESS).uint32(remoteId).done());
          }
          if (!started) {
            started = true;
            void Promise.resolve(opts.onSession(session)).catch((e) => opts.onError?.(e as Error));
          }
          break; // reply already sent
        } else if (type === "env" || type === "signal") {
          ok = true;
        }

        if (wantReply) {
          await t.send(
            new Writer()
              .byte(ok ? MSG.CHANNEL_SUCCESS : MSG.CHANNEL_FAILURE)
              .uint32(remoteId)
              .done(),
          );
        }
        break;
      }

      case MSG.CHANNEL_DATA: {
        r.uint32();
        const data = r.string();
        consumed += data.byteLength;
        if (consumed > LOCAL_WINDOW / 2) {
          await t.send(
            new Writer().byte(MSG.CHANNEL_WINDOW_ADJUST).uint32(remoteId).uint32(consumed).done(),
          );
          consumed = 0;
        }
        for (const cb of dataCbs) cb(data);
        break;
      }

      case MSG.CHANNEL_WINDOW_ADJUST: {
        r.uint32();
        remoteWindow += r.uint32();
        const w = windowWaiter;
        windowWaiter = undefined;
        w?.();
        break;
      }

      case MSG.CHANNEL_EOF:
        break;

      case MSG.CHANNEL_CLOSE:
      case MSG.DISCONNECT:
        closed = true;
        windowWaiter?.();
        for (const cb of closeCbs) cb();
        t.close();
        return;

      default:
        await t.send(new Writer().byte(MSG.UNIMPLEMENTED).uint32(t.sequenceIn).done());
    }
  }

  closed = true;
  windowWaiter?.();
  for (const cb of closeCbs) cb();
  t.close();
}
