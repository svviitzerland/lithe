package main

import (
	"encoding/json"
	"fmt"
)

// Color is either an xterm palette index or a "#rrggbb" string on the wire.
type Color struct {
	Set bool
	Idx int
	Hex string
}

func (c *Color) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		return nil
	}
	var n int
	if err := json.Unmarshal(b, &n); err == nil {
		c.Set, c.Idx = true, n
		return nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		c.Set, c.Hex = true, s
		return nil
	}
	return fmt.Errorf("bad color %s", b)
}

type PalEntry struct {
	Fg Color `json:"fg"`
	Bg Color `json:"bg"`
	At int   `json:"at"`
}

// Run is the tuple [text, paletteIndex].
type Run struct {
	Text string
	Pal  int
}

func (r *Run) UnmarshalJSON(b []byte) error {
	var raw []json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	if len(raw) == 0 {
		return fmt.Errorf("empty run")
	}
	if err := json.Unmarshal(raw[0], &r.Text); err != nil {
		return err
	}
	if len(raw) > 1 {
		if err := json.Unmarshal(raw[1], &r.Pal); err != nil {
			return err
		}
	}
	return nil
}

type Frame struct {
	W   int        `json:"w"`
	H   int        `json:"h"`
	Pal []PalEntry `json:"pal"`
	// A nil row means "unchanged since the last frame" — the origin diffs rows
	// so it never has to resend a screen that barely moved.
	Rows   [][]Run `json:"rows"`
	Cursor *[2]int `json:"cursor,omitempty"`
	Title  string  `json:"title,omitempty"`
	Bell   bool    `json:"bell,omitempty"`
}

// --- wire protocol ---

type Event struct {
	T    string `json:"t"`
	Key  string `json:"key,omitempty"`
	Rune string `json:"rune,omitempty"`
	Data string `json:"data,omitempty"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
}

type ClientCtx struct {
	User   string `json:"user"`
	Pubkey string `json:"pubkey,omitempty"`
	IP     string `json:"ip,omitempty"`
	Term   string `json:"term,omitempty"`
	App    string `json:"app,omitempty"`
}

type TuiRequest struct {
	V       int       `json:"v"`
	Sid     string    `json:"sid"`
	Session string    `json:"session,omitempty"`
	Size    [2]int    `json:"size"`
	Events  []Event   `json:"events"`
	Ctx     ClientCtx `json:"ctx"`
	Vst     string    `json:"vst,omitempty"`
	Full    bool      `json:"full,omitempty"`
}

type TuiResponse struct {
	V       int    `json:"v"`
	Session string `json:"session,omitempty"`
	Frame   *Frame `json:"frame,omitempty"`
	Vst     string `json:"vst,omitempty"`
	Partial bool   `json:"partial,omitempty"`
	Wake    *int   `json:"wake,omitempty"`
	Exit    *int   `json:"exit,omitempty"`
	Err     string `json:"err,omitempty"`
}

const protocolVersion = 1
