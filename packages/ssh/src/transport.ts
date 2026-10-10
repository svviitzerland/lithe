import { Reader, Writer, concat } from "./buffer.ts";
import { GcmCipher } from "./crypto.ts";

/** A bidirectional byte pipe: a TCP socket, a WebSocket, anything. */
export interface Duplex {
  write(data: Uint8Array): void | Promise<void>;
  close(): void;
}

const MAX_PACKET = 256 * 1024;

/**
 * Buffers inbound bytes so the protocol code can ask for exactly what it needs
 * next. Chunk boundaries from the transport never line up with packets.
 */
export class ByteQueue {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private want: { n: number; resolve: (b: Uint8Array) => void; reject: (e: Error) => void } | undefined;
  private ended: Error | null | undefined;

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.chunks.push(chunk);
    this.size += chunk.byteLength;
    this.settle();
  }

  end(err?: Error): void {
    this.ended = err ?? null;
    this.settle();
  }

  private settle(): void {
    const w = this.want;
    if (!w) return;
    if (this.size >= w.n) {
      this.want = undefined;
      w.resolve(this.take(w.n));
      return;
    }
    if (this.ended !== undefined) {
      this.want = undefined;
      w.reject(this.ended ?? new Error("ssh: connection closed"));
    }
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const head = this.chunks[0]!;
      const need = n - off;
      if (head.byteLength <= need) {
        out.set(head, off);
        off += head.byteLength;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, need), off);
        this.chunks[0] = head.subarray(need);
        off = n;
      }
    }
    this.size -= n;
    return out;
  }

  readExact(n: number): Promise<Uint8Array> {
    if (n === 0) return Promise.resolve(new Uint8Array(0));
    if (this.size >= n) return Promise.resolve(this.take(n));
    if (this.ended !== undefined) {
      return Promise.reject(this.ended ?? new Error("ssh: connection closed"));
    }
    return new Promise((resolve, reject) => {
      this.want = { n, resolve, reject };
    });
  }

  /** Reads one CRLF- or LF-terminated line, for the version exchange. */
  async readLine(limit = 255): Promise<string> {
    let line = "";
    for (let i = 0; i < limit; i++) {
      const [b] = await this.readExact(1);
      if (b === 0x0a) return line.endsWith("\r") ? line.slice(0, -1) : line;
      line += String.fromCharCode(b!);
    }
    throw new Error("ssh: version line too long");
  }
}

/**
 * The SSH binary packet protocol (RFC 4253 §6).
 *
 * Before key exchange completes, packets are plaintext with 8-byte alignment.
 * Afterwards they are sealed with aes256-gcm@openssh.com, where the 4-byte
 * length prefix stays in the clear and is authenticated as additional data.
 */
export class PacketTransport {
  private outSeq = 0;
  private inSeq = 0;
  private outCipher: GcmCipher | undefined;
  private inCipher: GcmCipher | undefined;
  /** set once both sides advertise kex-strict; resets sequence numbers at NEWKEYS */
  strictKex = false;
  private sendLock: Promise<void> = Promise.resolve();

  constructor(
    private stream: Duplex,
    private queue: ByteQueue,
  ) {}

  get sequenceIn(): number {
    return this.inSeq;
  }

  /**
   * Sends are serialized. The GCM counter advances per packet, so two
   * concurrent sends interleaving their awaits would encrypt with the wrong
   * nonce and the peer would drop the connection.
   */
  send(payload: Uint8Array): Promise<void> {
    const run = this.sendLock.then(() => this.sendNow(payload));
    this.sendLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async sendNow(payload: Uint8Array): Promise<void> {
    const block = this.outCipher ? 16 : 8;
    // With GCM the length field is outside the encrypted, aligned region.
    const prefix = this.outCipher ? 1 : 5;
    let pad = block - ((prefix + payload.byteLength) % block);
    if (pad < 4) pad += block;
    const packetLength = 1 + payload.byteLength + pad;
    const padding = crypto.getRandomValues(new Uint8Array(pad));
    const lengthBytes = new Writer().uint32(packetLength).done();
    const body = concat(new Uint8Array([pad]), payload, padding);

    const out = this.outCipher
      ? concat(lengthBytes, await this.outCipher.seal(body, lengthBytes))
      : concat(lengthBytes, body);

    this.outSeq = (this.outSeq + 1) >>> 0;
    await this.stream.write(out);
  }

  async receive(): Promise<Uint8Array> {
    const lengthBytes = await this.queue.readExact(4);
    const packetLength = new Reader(lengthBytes).uint32();
    if (packetLength < 8 || packetLength > MAX_PACKET) {
      throw new Error(`ssh: bad packet length ${packetLength}`);
    }

    let body: Uint8Array;
    if (this.inCipher) {
      if (packetLength % 16 !== 0) throw new Error("ssh: misaligned packet");
      const sealed = await this.queue.readExact(packetLength + 16);
      body = await this.inCipher.open(sealed, lengthBytes);
    } else {
      body = await this.queue.readExact(packetLength);
    }

    this.inSeq = (this.inSeq + 1) >>> 0;
    const pad = body[0]!;
    if (pad + 1 > body.byteLength) throw new Error("ssh: bad padding");
    return body.subarray(1, body.byteLength - pad);
  }

  async enableOut(key: Uint8Array, iv: Uint8Array): Promise<void> {
    this.outCipher = await GcmCipher.create(key, iv);
    if (this.strictKex) this.outSeq = 0;
  }

  async enableIn(key: Uint8Array, iv: Uint8Array): Promise<void> {
    this.inCipher = await GcmCipher.create(key, iv);
    if (this.strictKex) this.inSeq = 0;
  }

  write(data: Uint8Array): void | Promise<void> {
    return this.stream.write(data);
  }

  close(): void {
    this.stream.close();
  }
}

// RFC 4250 message numbers, plus the ones OpenSSH adds.
export const MSG = {
  DISCONNECT: 1,
  IGNORE: 2,
  UNIMPLEMENTED: 3,
  DEBUG: 4,
  SERVICE_REQUEST: 5,
  SERVICE_ACCEPT: 6,
  EXT_INFO: 7,
  KEXINIT: 20,
  NEWKEYS: 21,
  KEX_ECDH_INIT: 30,
  KEX_ECDH_REPLY: 31,
  USERAUTH_REQUEST: 50,
  USERAUTH_FAILURE: 51,
  USERAUTH_SUCCESS: 52,
  USERAUTH_BANNER: 53,
  USERAUTH_PK_OK: 60,
  USERAUTH_INFO_REQUEST: 60,
  USERAUTH_INFO_RESPONSE: 61,
  GLOBAL_REQUEST: 80,
  REQUEST_SUCCESS: 81,
  REQUEST_FAILURE: 82,
  CHANNEL_OPEN: 90,
  CHANNEL_OPEN_CONFIRMATION: 91,
  CHANNEL_OPEN_FAILURE: 92,
  CHANNEL_WINDOW_ADJUST: 93,
  CHANNEL_DATA: 94,
  CHANNEL_EXTENDED_DATA: 95,
  CHANNEL_EOF: 96,
  CHANNEL_CLOSE: 97,
  CHANNEL_REQUEST: 98,
  CHANNEL_SUCCESS: 99,
  CHANNEL_FAILURE: 100,
} as const;

export const DISCONNECT_BY_APPLICATION = 11;
