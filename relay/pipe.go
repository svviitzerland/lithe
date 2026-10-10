package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// PipeConfig turns the relay into a dumb byte pipe.
//
// This is the mode that asks nothing of the visitor. A stock `ssh your-app.com`
// works with no client configuration at all, because something is finally
// listening on port 22 — but that something terminates nothing. The SSH session
// is end-to-end between the user's client and the serverless function, so the
// pipe carries ciphertext it cannot read, holds no host key, and knows no
// usernames.
//
// Routing, when there is more than one app, is by destination address: give each
// app its own IPv6 from a routed block and the pipe recovers the app from the
// address the connection arrived on. No SNI needed, because no protocol parsing
// happens at all.
type PipeConfig struct {
	// single-app mode: everything goes here
	Origin string
	// multi-app mode: destination IP -> origin URL
	ByAddress map[string]string
	Timeout   time.Duration
	Verbose   bool
}

func LoadPipeMap(path string) (map[string]string, error) {
	if path == "" {
		return nil, nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var m map[string]string
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		// Normalize so "2a09::1" and "2a09:0:0::1" match.
		if ip := net.ParseIP(k); ip != nil {
			out[ip.String()] = v
		} else {
			out[k] = v
		}
	}
	return out, nil
}

// wsURL turns an https origin into the WebSocket endpoint that speaks SSH.
func wsURL(origin string) (string, error) {
	u, err := url.Parse(origin)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "wss", "ws":
		return u.String(), nil
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	default:
		return "", fmt.Errorf("unsupported scheme %q", u.Scheme)
	}
	if u.Path == "" || u.Path == "/" {
		u.Path = "/_lithe/ssh"
	}
	return u.String(), nil
}

func (p *PipeConfig) originFor(conn net.Conn) (string, error) {
	if len(p.ByAddress) > 0 {
		host, _, err := net.SplitHostPort(conn.LocalAddr().String())
		if err == nil {
			if ip := net.ParseIP(host); ip != nil {
				if o, ok := p.ByAddress[ip.String()]; ok {
					return o, nil
				}
			}
			if o, ok := p.ByAddress[host]; ok {
				return o, nil
			}
		}
		if p.Origin == "" {
			return "", fmt.Errorf("no app mapped to %s", conn.LocalAddr())
		}
	}
	if p.Origin == "" {
		return "", fmt.Errorf("no origin configured")
	}
	return p.Origin, nil
}

// ServePipe accepts TCP connections and splices each one onto a WebSocket.
func ServePipe(ln net.Listener, cfg PipeConfig, client *http.Client) error {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return err
		}
		go func() {
			defer conn.Close()
			if err := pipeOne(conn, cfg, client); err != nil && cfg.Verbose {
				log.Printf("pipe %s: %v", conn.RemoteAddr(), err)
			}
		}()
	}
}

func pipeOne(conn net.Conn, cfg PipeConfig, client *http.Client) error {
	origin, err := cfg.originFor(conn)
	if err != nil {
		return err
	}
	target, err := wsURL(origin)
	if err != nil {
		return err
	}

	// No overall deadline: an ssh session is meant to last.
	dialCtx, cancelDial := context.WithTimeout(context.Background(), cfg.Timeout)
	ws, _, err := websocket.Dial(dialCtx, target, &websocket.DialOptions{HTTPClient: client})
	cancelDial()
	if err != nil {
		return fmt.Errorf("dial %s: %w", target, err)
	}
	ws.SetReadLimit(8 << 20)
	defer ws.CloseNow()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	started := time.Now()
	var once sync.Once
	stop := func() { once.Do(cancel) }

	go func() {
		defer stop()
		buf := make([]byte, 32*1024)
		for {
			n, err := conn.Read(buf)
			if n > 0 {
				if werr := ws.Write(ctx, websocket.MessageBinary, buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	var total int
	for {
		typ, data, err := ws.Read(ctx)
		if err != nil {
			break
		}
		if typ != websocket.MessageBinary && typ != websocket.MessageText {
			continue
		}
		if _, err := conn.Write(data); err != nil {
			break
		}
		total += len(data)
	}
	stop()

	if cfg.Verbose {
		log.Printf("pipe %s -> %s closed after %s, %d bytes out",
			conn.RemoteAddr(), strings.Split(target, "?")[0], time.Since(started).Truncate(time.Millisecond), total)
	}
	return nil
}

var _ = io.Discard
