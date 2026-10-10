import { expect, test } from "bun:test";
import { ByteQueue, PacketTransport, type Duplex } from "../src/transport.ts";

/** Two transports wired into each other, as if over a socket. */
function loopback() {
  const toB = new ByteQueue();
  const toA = new ByteQueue();
  const pipeTo = (q: ByteQueue): Duplex => ({ write: (d) => q.push(d), close: () => q.end() });
  return {
    a: new PacketTransport(pipeTo(toB), toA),
    b: new PacketTransport(pipeTo(toA), toB),
  };
}

test("a plaintext packet survives the round trip", async () => {
  const { a, b } = loopback();
  const payload = new TextEncoder().encode("SSH_MSG_KEXINIT would go here");
  await a.send(payload);
  expect([...(await b.receive())]).toEqual([...payload]);
});

test("packets arriving in one chunk are still framed correctly", async () => {
  const { a, b } = loopback();
  await a.send(new Uint8Array([1]));
  await a.send(new Uint8Array([2, 2]));
  await a.send(new Uint8Array([3, 3, 3]));
  expect([...(await b.receive())]).toEqual([1]);
  expect([...(await b.receive())]).toEqual([2, 2]);
  expect([...(await b.receive())]).toEqual([3, 3, 3]);
});

test("encrypted packets round trip once the keys are in place", async () => {
  const { a, b } = loopback();
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  await a.enableOut(key, iv);
  await b.enableIn(key, iv);

  for (const size of [1, 15, 16, 17, 1000, 65535]) {
    const payload = crypto.getRandomValues(new Uint8Array(size));
    await a.send(payload);
    expect([...(await b.receive())]).toEqual([...payload]);
  }
});

test("both directions can be encrypted with different keys", async () => {
  const { a, b } = loopback();
  const k1 = crypto.getRandomValues(new Uint8Array(32));
  const iv1 = crypto.getRandomValues(new Uint8Array(12));
  const k2 = crypto.getRandomValues(new Uint8Array(32));
  const iv2 = crypto.getRandomValues(new Uint8Array(12));
  await a.enableOut(k1, iv1);
  await b.enableIn(k1, iv1);
  await b.enableOut(k2, iv2);
  await a.enableIn(k2, iv2);

  await a.send(new TextEncoder().encode("ping"));
  expect(new TextDecoder().decode(await b.receive())).toBe("ping");
  await b.send(new TextEncoder().encode("pong"));
  expect(new TextDecoder().decode(await a.receive())).toBe("pong");
});

test("concurrent sends stay in order, so the gcm counter matches", async () => {
  const { a, b } = loopback();
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  await a.enableOut(key, iv);
  await b.enableIn(key, iv);

  // Fired without awaiting each one: the transport must serialize them.
  await Promise.all([
    a.send(new Uint8Array([1])),
    a.send(new Uint8Array([2])),
    a.send(new Uint8Array([3])),
  ]);
  expect([...(await b.receive())]).toEqual([1]);
  expect([...(await b.receive())]).toEqual([2]);
  expect([...(await b.receive())]).toEqual([3]);
});

test("an absurd packet length is refused instead of allocated", async () => {
  const q = new ByteQueue();
  const t = new PacketTransport({ write: () => {}, close: () => {} }, q);
  q.push(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  await expect(t.receive()).rejects.toThrow(/bad packet length/);
});

test("reads reject once the connection ends", async () => {
  const q = new ByteQueue();
  const t = new PacketTransport({ write: () => {}, close: () => {} }, q);
  const pending = t.receive();
  q.end();
  await expect(pending).rejects.toThrow();
});

test("the byte queue reassembles split and merged chunks", async () => {
  const q = new ByteQueue();
  const want = q.readExact(5);
  q.push(new Uint8Array([1, 2]));
  q.push(new Uint8Array([3]));
  q.push(new Uint8Array([4, 5, 6]));
  expect([...(await want)]).toEqual([1, 2, 3, 4, 5]);
  expect([...(await q.readExact(1))]).toEqual([6]);
});

test("the byte queue reads the version-exchange line", async () => {
  const q = new ByteQueue();
  q.push(new TextEncoder().encode("SSH-2.0-OpenSSH_9.8\r\nmore"));
  expect(await q.readLine()).toBe("SSH-2.0-OpenSSH_9.8");
});
