import { expect, test } from "bun:test";
import { Reader, Writer, concat, equalBytes } from "../src/buffer.ts";

test("strings and name-lists round trip", () => {
  const b = new Writer().string("hello").nameList(["a", "b"]).nameList([]).done();
  const r = new Reader(b);
  expect(r.text()).toBe("hello");
  expect(r.nameList()).toEqual(["a", "b"]);
  expect(r.nameList()).toEqual([]);
  expect(r.remaining).toBe(0);
});

test("integers and booleans round trip", () => {
  const b = new Writer().byte(7).bool(true).bool(false).uint32(4294967295).done();
  const r = new Reader(b);
  expect(r.byte()).toBe(7);
  expect(r.bool()).toBe(true);
  expect(r.bool()).toBe(false);
  expect(r.uint32()).toBe(4294967295);
});

// mpint is where a key exchange silently breaks if you get it wrong: the shared
// secret is hashed in this exact form.
test("mpint strips leading zeros", () => {
  const b = new Writer().mpint(new Uint8Array([0, 0, 0x12, 0x34])).done();
  expect([...b]).toEqual([0, 0, 0, 2, 0x12, 0x34]);
});

test("mpint prepends a zero when the top bit is set, to stay positive", () => {
  const b = new Writer().mpint(new Uint8Array([0xff, 0x01])).done();
  expect([...b]).toEqual([0, 0, 0, 3, 0x00, 0xff, 0x01]);
});

test("mpint of zero is an empty string", () => {
  const b = new Writer().mpint(new Uint8Array([0, 0, 0])).done();
  expect([...b]).toEqual([0, 0, 0, 0]);
});

test("a truncated packet is rejected, not read past", () => {
  const r = new Reader(new Uint8Array([0, 0, 0, 10, 1, 2]));
  expect(() => r.string()).toThrow(/truncated/);
});

test("concat and equalBytes", () => {
  const joined = concat(new Uint8Array([1, 2]), new Uint8Array([3]));
  expect([...joined]).toEqual([1, 2, 3]);
  expect(equalBytes(joined, new Uint8Array([1, 2, 3]))).toBe(true);
  expect(equalBytes(joined, new Uint8Array([1, 2, 4]))).toBe(false);
  expect(equalBytes(joined, new Uint8Array([1, 2]))).toBe(false);
});
