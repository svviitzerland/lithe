import { expect, test } from "bun:test";
import { defineApp } from "../src/app.ts";
import { createHandler } from "../src/handler.ts";
import { box, text } from "@lithe/core";
import type { TuiRequest, TuiResponse } from "../src/protocol.ts";

const app = defineApp<{ n: number; who: string }>({
  name: "test app",
  description: "a test",
  init: (ctx) => ({ n: 0, who: ctx.pubkey ?? "anon" }),
  update(s, ev, io) {
    if (ev.t === "key" && ev.key === "up") s.n++;
    if (ev.t === "key" && ev.key === "q") io.exit(3);
    if (ev.t === "key" && ev.key === "w") io.wake(250);
  },
  view: (s) => box([text(`n=${s.n}`), text(`who=${s.who}`)]),
});

const handle = createHandler(app, { secret: "s", relay: "lithe.sh" });
const URL_ = "https://demo.example/api/tui";

function post(body: Partial<TuiRequest>): Promise<TuiResponse> {
  return handle(
    new Request(URL_, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: 1, sid: "t", size: [40, 6], events: [], ctx: { user: "u" }, ...body }),
    }),
  ).then((r) => r.json() as Promise<TuiResponse>);
}

function flatten(res: TuiResponse): string {
  return (res.frame?.rows ?? []).map((r) => (r ?? []).map(([t]) => t).join("")).join("\n");
}

test("GET returns a manifest, and HTML when a browser asks", async () => {
  const json = await handle(new Request(URL_)).then((r) => r.json());
  expect(json).toMatchObject({ lithe: 1, name: "test app", modes: ["stateless"] });
  expect((json as { connect: string }).connect).toBe("ssh demo.example@lithe.sh");

  const html = await handle(new Request(URL_, { headers: { accept: "text/html" } }));
  expect(html.headers.get("content-type")).toContain("text/html");
  expect(await html.text()).toContain("ssh demo.example@lithe.sh");
});

test("a first request initialises and renders", async () => {
  const res = await post({ events: [{ t: "init" }], full: true });
  expect(flatten(res)).toContain("n=0");
  expect(res.session).toBeString();
  expect(res.partial).toBeUndefined();
});

test("events fold in order across requests", async () => {
  let res = await post({ events: [{ t: "init" }], full: true });
  res = await post({ session: res.session, vst: res.vst, events: [{ t: "key", key: "up" }, { t: "key", key: "up" }] });
  expect(flatten(res)).toContain("n=2");
});

test("unchanged rows come back as null", async () => {
  const first = await post({ events: [{ t: "init" }], full: true });
  const second = await post({ session: first.session, vst: first.vst, events: [{ t: "key", key: "up" }] });
  expect(second.partial).toBe(true);
  const nulls = (second.frame?.rows ?? []).filter((r) => r === null).length;
  expect(nulls).toBeGreaterThan(3);
  expect(flatten(second)).toContain("n=1");
});

test("full:true suppresses partial frames", async () => {
  const first = await post({ events: [{ t: "init" }], full: true });
  const again = await post({ session: first.session, vst: first.vst, events: [], full: true });
  expect(again.partial).toBeUndefined();
  expect((again.frame?.rows ?? []).every((r) => r !== null)).toBe(true);
});

test("io.exit ends the session and drops the state", async () => {
  const first = await post({ events: [{ t: "init" }], full: true });
  const res = await post({ session: first.session, events: [{ t: "key", key: "q" }] });
  expect(res.exit).toBe(3);
  expect(res.session).toBeUndefined();
});

test("io.wake is reported to the caller", async () => {
  const first = await post({ events: [{ t: "init" }], full: true });
  const res = await post({ session: first.session, events: [{ t: "key", key: "w" }] });
  expect(res.wake).toBe(250);
});

test("an unusable session replays init instead of failing", async () => {
  const res = await post({ session: "garbage", events: [{ t: "key", key: "up" }] });
  expect(flatten(res)).toContain("n=1"); // init ran, then the key applied
  expect(res.session).toBeString();
});

test("the client context reaches init", async () => {
  const res = await post({ events: [{ t: "init" }], full: true, ctx: { user: "x", pubkey: "SHA256:abc" } });
  expect(flatten(res)).toContain("who=SHA256:abc");
});

test("terminal size is clamped to something sane", async () => {
  const res = await post({ events: [{ t: "init" }], full: true, size: [0, 0] });
  expect(res.frame?.w).toBe(20);
  expect(res.frame?.h).toBe(5);
});

test("an app that throws returns a clean error instead of a 500", async () => {
  const boom = defineApp({
    init: () => ({}),
    update: () => {
      throw new Error("kaboom");
    },
    view: () => text("never"),
  });
  const res = await createHandler(boom, { secret: "s" })(
    new Request(URL_, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: 1, sid: "t", size: [20, 5], events: [{ t: "init" }], ctx: { user: "u" } }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as TuiResponse;
  expect(body.exit).toBe(1);
  expect(body.err).toContain("kaboom");
});

test("bad input is rejected politely", async () => {
  const bad = await handle(new Request(URL_, { method: "POST", body: "{{{" }));
  expect(bad.status).toBe(400);
  const wrong = await handle(new Request(URL_, { method: "DELETE" }));
  expect(wrong.status).toBe(405);
});
