package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func frameFromJSON(t *testing.T, s string) *Frame {
	t.Helper()
	var f Frame
	if err := json.Unmarshal([]byte(s), &f); err != nil {
		t.Fatalf("unmarshal frame: %v", err)
	}
	return &f
}

func TestRunAndColorUnmarshal(t *testing.T) {
	f := frameFromJSON(t, `{"w":5,"h":1,"pal":[{},{"fg":6,"at":1},{"fg":"#36d7b7"}],"rows":[[["ab",1],["c",2]]]}`)
	if len(f.Rows[0]) != 2 || f.Rows[0][0].Text != "ab" || f.Rows[0][0].Pal != 1 {
		t.Fatalf("bad run parse: %+v", f.Rows[0])
	}
	if !f.Pal[1].Fg.Set || f.Pal[1].Fg.Idx != 6 || f.Pal[1].At != 1 {
		t.Fatalf("bad palette index colour: %+v", f.Pal[1])
	}
	if f.Pal[2].Fg.Hex != "#36d7b7" {
		t.Fatalf("bad truecolor: %+v", f.Pal[2])
	}
}

func TestFullFrameThenSmallDiff(t *testing.T) {
	fw := NewFrameWriter(true)
	if !fw.NeedsFull(5, 1) {
		t.Fatal("a fresh writer must ask for a full frame")
	}
	first := fw.Update(frameFromJSON(t, `{"w":5,"h":1,"pal":[{}],"rows":[[["hello",0]]]}`))
	if !strings.Contains(first, "hello") || !strings.Contains(first, "\x1b[2J") {
		t.Fatalf("first paint should clear and draw everything: %q", first)
	}
	if fw.NeedsFull(5, 1) {
		t.Fatal("writer should not need a full frame at a size it just drew")
	}
	if !fw.NeedsFull(80, 24) {
		t.Fatal("writer must ask for a full frame at an unseen size")
	}
	second := fw.Update(frameFromJSON(t, `{"w":5,"h":1,"pal":[{}],"rows":[[["hellp",0]]]}`))
	if len(second) >= len(first) {
		t.Fatalf("diff should be smaller than a full paint: %q", second)
	}
	if !strings.Contains(second, "\x1b[1;5H") {
		t.Fatalf("diff should address column 5: %q", second)
	}
}

func TestNilRowsCarryForward(t *testing.T) {
	fw := NewFrameWriter(true)
	fw.Update(frameFromJSON(t, `{"w":7,"h":2,"pal":[{}],"rows":[[["keep me",0]],[["change ",0]]]}`))
	partial := frameFromJSON(t, `{"w":7,"h":2,"pal":[{}],"rows":[null,[["changed",0]]]}`)
	out := fw.Update(partial)
	if strings.Contains(out, "keep me") {
		t.Fatalf("an unchanged row must not be redrawn: %q", out)
	}
	// The row is still held: a forced repaint brings it back.
	fw.Invalidate()
	repaint := fw.Update(partial)
	if !strings.Contains(repaint, "keep me") || !strings.Contains(repaint, "changed") {
		t.Fatalf("repaint lost carried-forward content: %q", repaint)
	}
}

func TestWideCharactersConsumeTwoColumns(t *testing.T) {
	fw := NewFrameWriter(true)
	out := fw.Update(frameFromJSON(t, `{"w":6,"h":1,"pal":[{}],"rows":[[["日本x",0]]]}`))
	if !strings.Contains(out, "日本x") {
		t.Fatalf("wide glyphs should survive: %q", out)
	}
	if charWidth('日') != 2 || charWidth('a') != 1 || charWidth('̀') != 0 {
		t.Fatal("width table disagrees with the TypeScript one")
	}
}

func TestTruecolorDegradesTo256(t *testing.T) {
	plain := NewFrameWriter(false).Update(frameFromJSON(t, `{"w":1,"h":1,"pal":[{},{"fg":"#ff0000"}],"rows":[[["x",1]]]}`))
	if !strings.Contains(plain, "38;5;") {
		t.Fatalf("without truecolor support the writer must use the 256 cube: %q", plain)
	}
	rich := NewFrameWriter(true).Update(frameFromJSON(t, `{"w":1,"h":1,"pal":[{},{"fg":"#ff0000"}],"rows":[[["x",1]]]}`))
	if !strings.Contains(rich, "38;2;255;0;0") {
		t.Fatalf("truecolor expected: %q", rich)
	}
}

func TestResolverRejectsUnsafeOrigins(t *testing.T) {
	r := &Resolver{}
	if err := r.validate("http://example.com/tui"); err == nil {
		t.Fatal("plain http must be refused")
	}
	if err := r.validate("https://127.0.0.1/tui"); err == nil {
		t.Fatal("loopback origins must be refused")
	}
	dev := &Resolver{AllowPrivate: true}
	if err := dev.validate("http://127.0.0.1:8787/tui"); err != nil {
		t.Fatalf("--allow-private should permit local development: %v", err)
	}
}

func TestHostKeyIsDeterministic(t *testing.T) {
	a, err := DeriveHostKey("seed-one", "relay")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := DeriveHostKey("seed-one", "relay")
	c, _ := DeriveHostKey("seed-two", "relay")
	d, _ := DeriveHostKey("seed-one", "other-label")
	if Fingerprint(a) != Fingerprint(b) {
		t.Fatal("same seed and label must give the same host key")
	}
	if Fingerprint(a) == Fingerprint(c) || Fingerprint(a) == Fingerprint(d) {
		t.Fatal("different seed or label must give a different host key")
	}
	if !strings.HasPrefix(Fingerprint(a), "SHA256:") {
		t.Fatalf("unexpected fingerprint format: %s", Fingerprint(a))
	}
}
