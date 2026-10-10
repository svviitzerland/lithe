import { expect, test } from "bun:test";
import { box, input, list, row, rule, spacer, text } from "../src/widgets.ts";
import { renderToScreen } from "../src/layout.ts";
import { FrameWriter } from "../src/terminal.ts";
import { strWidth, truncate } from "../src/width.ts";
import type { Frame } from "../src/frame.ts";

/** Flatten a frame back to plain text lines, which is what we assert against. */
function lines(f: Frame): string[] {
  return f.rows.map((r) => (r ?? []).map(([t]) => t).join("").replace(/\s+$/, ""));
}

test("display width counts wide and zero-width characters", () => {
  expect(strWidth("abc")).toBe(3);
  expect(strWidth("日本")).toBe(4);
  expect(strWidth("é")).toBe(1); // combining acute
  expect(truncate("hello world", 8)).toBe("hello w…");
  expect(truncate("hello", 8)).toBe("hello");
});

test("row puts a spacer's slack between its children", () => {
  const f = renderToScreen(row([text("left"), spacer(), text("right")]), 20, 1).toFrame();
  expect(lines(f)[0]).toBe("left           right");
});

test("box draws a border with a title and pads its children", () => {
  const f = renderToScreen(box({ border: "round", title: "hi", pad: 1 }, [text("x")]), 11, 5).toFrame();
  expect(lines(f)).toEqual(["╭ hi ─────╮", "│         │", "│ x       │", "│         │", "╰─────────╯"]);
});

test("rule fills its width exactly, with no ellipsis", () => {
  const f = renderToScreen(rule(), 6, 1).toFrame();
  expect(lines(f)[0]).toBe("──────");
});

test("a list keeps the selection inside the height it was given", () => {
  const items = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const f = renderToScreen(box({ h: 3 }, [list(items, 7)]), 10, 3).toFrame();
  const shown = lines(f);
  expect(shown.some((l) => l.includes("› h"))).toBe(true);
  expect(shown.length).toBe(3);
});

test("input parks the terminal cursor after the caret", () => {
  const sc = renderToScreen(input("abc", 2, { label: "name:", focused: true }), 30, 1);
  // "name:" is 5 columns, then a one-column gap, so the caret sits at 5 + 1 + 2.
  expect(sc.cursor).toEqual([8, 0]);
});

test("the frame writer emits a small diff for a small change", () => {
  const w = new FrameWriter();
  const a = renderToScreen(box([text("hello"), text("world")]), 40, 4).toFrame();
  const first = w.update(a);
  expect(w.needsFull(40, 4)).toBe(false);
  expect(w.needsFull(80, 4)).toBe(true); // a size we have never drawn
  const b = renderToScreen(box([text("hello"), text("w0rld")]), 40, 4).toFrame();
  const second = w.update(b);
  // Only the one changed cell is redrawn, addressed at row 2, column 2.
  expect(second.length).toBeLessThan(first.length / 4);
  expect(second.length).toBeLessThan(40);
  expect(second).toContain("\x1b[2;2H");
  expect(second).toContain("0");
});

test("null rows carry the previous frame forward", () => {
  const w = new FrameWriter();
  const full = renderToScreen(box([text("keep me"), text("change me")]), 20, 2).toFrame();
  w.update(full);
  const partial: Frame = { ...full, rows: [null, [["changed", 0]]] };
  const out = w.update(partial);
  expect(out).not.toContain("keep me"); // unchanged row, so not redrawn
  // The carried-forward row is really in the grid: force a repaint and it is back.
  w.invalidate();
  const repaint = w.update(partial);
  expect(repaint).toContain("keep me");
  expect(repaint).toContain("changed");
});

test("a resize forces a full repaint", () => {
  const w = new FrameWriter();
  w.update(renderToScreen(text("x"), 10, 2).toFrame());
  expect(w.update(renderToScreen(text("x"), 20, 2).toFrame())).toContain("\x1b[2J");
});
