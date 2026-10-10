package main

import (
	"fmt"
	"strings"
)

// A cell grid reconstructed from a frame, kept so the next frame can be diffed
// against it. This is the Go twin of core's FrameWriter.
type grid struct {
	w, h int
	ch   []string
	st   []PalEntry
}

type FrameWriter struct {
	// shown is what the terminal is displaying: the basis for the next diff.
	shown *grid
	// content is the last complete grid, used to fill in unchanged rows.
	content   *grid
	truecolor bool
	lastTitle string
}

func NewFrameWriter(truecolor bool) *FrameWriter {
	return &FrameWriter{truecolor: truecolor}
}

// Invalidate forgets what is on screen so the next frame repaints fully. The
// content is kept: a repaint still needs a source for unchanged rows.
func (fw *FrameWriter) Invalidate() { fw.shown = nil }

// NeedsFull reports that the origin must send every row, because we have
// nothing to fill the gaps with at this size.
func (fw *FrameWriter) NeedsFull(cols, rows int) bool {
	return fw.content == nil || fw.content.w != cols || fw.content.h != rows
}

func expand(f *Frame, prev *grid) *grid {
	g := &grid{w: f.W, h: f.H, ch: make([]string, f.W*f.H), st: make([]PalEntry, f.W*f.H)}
	for i := range g.ch {
		g.ch[i] = " "
	}
	var reusable *grid
	if prev != nil && prev.w == f.W && prev.h == f.H {
		reusable = prev
	}
	for y := 0; y < f.H && y < len(f.Rows); y++ {
		if f.Rows[y] == nil {
			if reusable != nil {
				copy(g.ch[y*f.W:(y+1)*f.W], reusable.ch[y*f.W:(y+1)*f.W])
				copy(g.st[y*f.W:(y+1)*f.W], reusable.st[y*f.W:(y+1)*f.W])
			}
			continue
		}
		x := 0
		for _, run := range f.Rows[y] {
			var entry PalEntry
			if run.Pal >= 0 && run.Pal < len(f.Pal) {
				entry = f.Pal[run.Pal]
			}
			for _, r := range run.Text {
				if x >= f.W {
					break
				}
				cw := charWidth(r)
				i := y*f.W + x
				g.ch[i] = string(r)
				g.st[i] = entry
				if cw == 2 && x+1 < f.W {
					g.ch[i+1] = ""
					g.st[i+1] = entry
					x += 2
				} else {
					x++
				}
			}
		}
	}
	return g
}

func sgrColor(c Color, fg bool, truecolor bool) string {
	base := 48
	off := 49
	if fg {
		base, off = 38, 39
	}
	if !c.Set {
		return fmt.Sprint(off)
	}
	if c.Hex == "" {
		return fmt.Sprintf("%d;5;%d", base, c.Idx)
	}
	var r, g, b int
	if _, err := fmt.Sscanf(c.Hex, "#%02x%02x%02x", &r, &g, &b); err != nil {
		return fmt.Sprint(off)
	}
	if truecolor {
		return fmt.Sprintf("%d;2;%d;%d;%d", base, r, g, b)
	}
	q := func(v int) int { return (v*5 + 127) / 255 }
	return fmt.Sprintf("%d;5;%d", base, 16+36*q(r)+6*q(g)+q(b))
}

func sgr(e PalEntry, truecolor bool) string {
	codes := []string{"0"}
	attrs := [...]struct {
		bit  int
		code string
	}{{1, "1"}, {2, "2"}, {4, "3"}, {8, "4"}, {16, "7"}, {32, "9"}}
	for _, a := range attrs {
		if e.At&a.bit != 0 {
			codes = append(codes, a.code)
		}
	}
	if e.Fg.Set {
		codes = append(codes, sgrColor(e.Fg, true, truecolor))
	}
	if e.Bg.Set {
		codes = append(codes, sgrColor(e.Bg, false, truecolor))
	}
	return "\x1b[" + strings.Join(codes, ";") + "m"
}

func sameStyle(a, b PalEntry) bool {
	return a.Fg == b.Fg && a.Bg == b.Bg && a.At == b.At
}

// Update returns the ANSI bytes that turn the previous frame into this one.
func (fw *FrameWriter) Update(f *Frame) string {
	g := expand(f, fw.content)
	full := fw.shown == nil || fw.shown.w != g.w || fw.shown.h != g.h
	var out strings.Builder
	if full {
		out.WriteString("\x1b[2J")
	}

	cx, cy := -1, -1
	var cur *PalEntry

	unchanged := func(i int) bool {
		if full || fw.shown == nil {
			return false
		}
		return fw.shown.ch[i] == g.ch[i] && sameStyle(fw.shown.st[i], g.st[i])
	}

	for y := 0; y < g.h; y++ {
		x := 0
		for x < g.w {
			i := y*g.w + x
			if g.ch[i] == "" {
				x++
				continue
			}
			if unchanged(i) {
				x++
				continue
			}
			// Extend through short unchanged gaps rather than paying for a
			// cursor move every few columns.
			end, gap := x, 0
			for xx := x; xx < g.w; xx++ {
				if unchanged(y*g.w + xx) {
					gap++
					if gap > 4 {
						break
					}
				} else {
					gap = 0
					end = xx
				}
			}

			if cy != y || cx != x {
				fmt.Fprintf(&out, "\x1b[%d;%dH", y+1, x+1)
			}
			for xx := x; xx <= end; xx++ {
				ii := y*g.w + xx
				if g.ch[ii] == "" {
					continue
				}
				st := g.st[ii]
				if cur == nil || !sameStyle(*cur, st) {
					out.WriteString(sgr(st, fw.truecolor))
					s := st
					cur = &s
				}
				out.WriteString(g.ch[ii])
			}
			cx, cy = end+1, y
			x = end + 1
		}
	}

	if cur != nil {
		out.WriteString("\x1b[0m")
	}
	if f.Title != "" && f.Title != fw.lastTitle {
		fmt.Fprintf(&out, "\x1b]0;%s\x07", f.Title)
		fw.lastTitle = f.Title
	}
	if f.Bell {
		out.WriteString("\x07")
	}
	if f.Cursor != nil {
		fmt.Fprintf(&out, "\x1b[%d;%dH\x1b[?25h", f.Cursor[1]+1, f.Cursor[0]+1)
	} else {
		out.WriteString("\x1b[?25l")
	}

	fw.shown = g
	fw.content = g
	return out.String()
}

const (
	enterTUI = "\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H"
	exitTUI  = "\x1b[?25h\x1b[?1049l"
)
