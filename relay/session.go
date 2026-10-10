package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/gliderlabs/ssh"
	gossh "golang.org/x/crypto/ssh"
)

type Config struct {
	Addr        string
	MaxRPS      int
	Idle        time.Duration
	MaxDuration time.Duration
	Coalesce    time.Duration
	Timeout     time.Duration
	Verbose     bool
}

type Relay struct {
	cfg      Config
	resolver *Resolver
	client   *http.Client
}

func NewRelay(cfg Config, res *Resolver) *Relay {
	r := &Relay{
		cfg:      cfg,
		resolver: res,
		// Reuse connections aggressively: every keystroke is a request, so a
		// fresh TLS handshake per frame would dominate the latency budget.
		client: &http.Client{
			Timeout: cfg.Timeout,
			Transport: &http.Transport{
				MaxIdleConns:        512,
				MaxIdleConnsPerHost: 64,
				IdleConnTimeout:     90 * time.Second,
				ForceAttemptHTTP2:   true,
			},
		},
	}
	// Discovery reuses the session client: same connection pool, same timeouts.
	res.Client = r.client
	return r
}

func randID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (r *Relay) post(ctx context.Context, origin string, req TuiRequest) (*TuiResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost, origin, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	hreq.Header.Set("content-type", "application/json")
	hreq.Header.Set("user-agent", "lithe-relay/0.1")
	res, err := r.client.Do(hreq)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		snippet, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return nil, fmt.Errorf("origin returned %d: %s", res.StatusCode, strings.TrimSpace(string(snippet)))
	}
	var out TuiResponse
	if err := json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(&out); err != nil {
		return nil, fmt.Errorf("bad response from origin: %w", err)
	}
	return &out, nil
}

// Handle runs one SSH session: terminal in, frames out.
func (r *Relay) Handle(s ssh.Session) {
	pty, winCh, isPty := s.Pty()
	if !isPty {
		fmt.Fprintln(s.Stderr(), "lithe needs a terminal. Try:  ssh -t "+s.User()+"@<relay>")
		_ = s.Exit(1)
		return
	}

	ctx, cancel := context.WithTimeout(s.Context(), r.cfg.MaxDuration)
	defer cancel()

	appID, origin, err := r.resolver.Resolve(ctx, s.User())
	if err != nil {
		fmt.Fprintf(s.Stderr(), "lithe: %v\r\n", err)
		_ = s.Exit(1)
		return
	}

	cctx := ClientCtx{User: s.User(), Term: pty.Term, App: appID}
	if host, _, e := net.SplitHostPort(s.RemoteAddr().String()); e == nil {
		cctx.IP = host
	}
	if k := s.PublicKey(); k != nil {
		cctx.Pubkey = gossh.FingerprintSHA256(k)
	}
	// The app identifies people by key fingerprint, not by username: the
	// username is the routing label, so it cannot also be an identity.
	if cctx.Pubkey == "" {
		cctx.User = "anon"
	}

	// Some clients (and `ssh -T`) report a 0x0 window. Treat any non-positive
	// dimension as "unknown" and keep the last size we trusted.
	cols, rows := 80, 24
	setSize := func(w, h int) bool {
		nw, nh := cols, rows
		if w > 0 {
			nw = clampInt(w, 20, 500)
		}
		if h > 0 {
			nh = clampInt(h, 5, 200)
		}
		if nw == cols && nh == rows {
			return false
		}
		cols, rows = nw, nh
		return true
	}
	setSize(pty.Window.Width, pty.Window.Height)

	fw := NewFrameWriter(supportsTruecolor(pty.Term))
	_, _ = s.Write([]byte(enterTUI))
	defer func() { _, _ = s.Write([]byte(exitTUI)) }()

	evCh := make(chan []Event, 128)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := s.Read(buf)
			if n > 0 {
				evs := DecodeInput(string(buf[:n]))
				if len(evs) > 0 {
					select {
					case evCh <- evs:
					case <-ctx.Done():
						return
					}
				}
			}
			if err != nil {
				close(evCh)
				return
			}
		}
	}()

	sid := randID()
	session := ""
	vst := ""
	pending := []Event{{T: "init"}}

	wake := time.NewTimer(time.Hour)
	wake.Stop()
	defer wake.Stop()
	idle := time.NewTimer(r.cfg.Idle)
	defer idle.Stop()

	minInterval := time.Second / time.Duration(max(1, r.cfg.MaxRPS))
	lastPost := time.Now().Add(-time.Second)
	frames := 0
	start := time.Now()

	defer func() {
		if r.cfg.Verbose {
			log.Printf("session %s app=%s user=%s frames=%d dur=%s", sid, appID, cctx.User, frames, time.Since(start).Truncate(time.Millisecond))
		}
	}()

	for {
		if len(pending) == 0 {
			select {
			case evs, ok := <-evCh:
				if !ok {
					return // client closed the connection
				}
				pending = append(pending, evs...)
			case w := <-winCh:
				if setSize(w.Width, w.Height) {
					fw.Invalidate()
					pending = append(pending, Event{T: "resize", Cols: cols, Rows: rows})
				}
			case <-wake.C:
				pending = append(pending, Event{T: "tick"})
			case <-idle.C:
				fmt.Fprint(s.Stderr(), "\r\nlithe: disconnected after inactivity\r\n")
				_ = s.Exit(0)
				return
			case <-ctx.Done():
				return
			}
		}

		// Coalesce a burst of input into one round trip. Holding a key down or
		// pasting should not cost one request per byte.
		if r.cfg.Coalesce > 0 {
			drain := time.NewTimer(r.cfg.Coalesce)
		drainLoop:
			for {
				select {
				case evs, ok := <-evCh:
					if !ok {
						drain.Stop()
						break drainLoop
					}
					pending = append(pending, evs...)
				case w := <-winCh:
					if setSize(w.Width, w.Height) {
						fw.Invalidate()
						pending = append(pending, Event{T: "resize", Cols: cols, Rows: rows})
					}
				case <-drain.C:
					break drainLoop
				}
			}
		}

		if len(pending) > 128 {
			pending = pending[len(pending)-128:]
		}

		// Rate limit, so a stuck key cannot run up an invoice.
		if wait := minInterval - time.Since(lastPost); wait > 0 {
			select {
			case <-time.After(wait):
			case <-ctx.Done():
				return
			}
		}

		req := TuiRequest{
			V: protocolVersion, Sid: sid, Session: session, Vst: vst,
			Size: [2]int{cols, rows}, Events: pending, Ctx: cctx,
			Full: fw.NeedsFull(cols, rows),
		}
		pending = nil
		lastPost = time.Now()

		res, err := r.post(ctx, origin, req)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			fmt.Fprintf(s.Stderr(), "\r\nlithe: %v\r\n", err)
			_ = s.Exit(1)
			return
		}
		frames++

		if res.Session != "" {
			session = res.Session
		}
		vst = res.Vst
		if res.Frame != nil {
			if _, err := s.Write([]byte(fw.Update(res.Frame))); err != nil {
				return
			}
		}
		if res.Err != "" {
			fmt.Fprintf(s.Stderr(), "\r\n%s\r\n", res.Err)
		}
		if res.Exit != nil {
			_ = s.Exit(*res.Exit)
			return
		}

		if res.Wake != nil {
			wake.Stop()
			wake.Reset(time.Duration(*res.Wake) * time.Millisecond)
		}
		idle.Stop()
		idle.Reset(r.cfg.Idle)
	}
}

func supportsTruecolor(term string) bool {
	t := strings.ToLower(term)
	return strings.Contains(t, "256color") || strings.Contains(t, "truecolor") || strings.Contains(t, "direct")
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
