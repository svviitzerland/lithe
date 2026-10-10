package main

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestWsURLDerivesTheSshEndpoint(t *testing.T) {
	cases := map[string]string{
		"https://app.vercel.app":              "wss://app.vercel.app/_lithe/ssh",
		"https://app.vercel.app/":             "wss://app.vercel.app/_lithe/ssh",
		"https://app.workers.dev/_lithe/ssh":  "wss://app.workers.dev/_lithe/ssh",
		"https://app.example.com/custom/path": "wss://app.example.com/custom/path",
		"wss://already.example/_lithe/ssh":    "wss://already.example/_lithe/ssh",
		"http://127.0.0.1:8790":               "ws://127.0.0.1:8790/_lithe/ssh",
	}
	for in, want := range cases {
		got, err := wsURL(in)
		if err != nil {
			t.Fatalf("wsURL(%q): %v", in, err)
		}
		if got != want {
			t.Errorf("wsURL(%q) = %q, want %q", in, got, want)
		}
	}
	if _, err := wsURL("ftp://nope.example"); err == nil {
		t.Error("an unsupported scheme should be refused")
	}
}

type fakeConn struct {
	net.Conn
	local net.Addr
}

func (f fakeConn) LocalAddr() net.Addr { return f.local }

func addr(s string) net.Addr {
	a, _ := net.ResolveTCPAddr("tcp", s)
	return a
}

// Routing by destination address is what lets a pipe serve many apps without
// parsing a single byte of the protocol.
func TestOriginForRoutesByDestinationAddress(t *testing.T) {
	cfg := PipeConfig{
		ByAddress: map[string]string{
			"2a09:0:0:0:0:0:0:1": "https://one.example",
			"203.0.113.7":        "https://two.example",
		},
	}
	// The map is normalized on load, so look-ups must match either spelling.
	normalized, err := LoadPipeMap(writeTemp(t, `{"2a09::1":"https://one.example","203.0.113.7":"https://two.example"}`))
	if err != nil {
		t.Fatal(err)
	}
	cfg.ByAddress = normalized

	got, err := cfg.originFor(fakeConn{local: addr("[2a09::1]:22")})
	if err != nil || got != "https://one.example" {
		t.Fatalf("ipv6 route: got %q, %v", got, err)
	}
	got, err = cfg.originFor(fakeConn{local: addr("203.0.113.7:22")})
	if err != nil || got != "https://two.example" {
		t.Fatalf("ipv4 route: got %q, %v", got, err)
	}
	if _, err := cfg.originFor(fakeConn{local: addr("198.51.100.1:22")}); err == nil {
		t.Error("an unmapped address should be refused, not guessed")
	}
}

func TestOriginForFallsBackToSingleApp(t *testing.T) {
	cfg := PipeConfig{Origin: "https://only.example"}
	got, err := cfg.originFor(fakeConn{local: addr("198.51.100.1:22")})
	if err != nil || got != "https://only.example" {
		t.Fatalf("single-app mode: got %q, %v", got, err)
	}

	empty := PipeConfig{}
	if _, err := empty.originFor(fakeConn{local: addr("198.51.100.1:22")}); err == nil {
		t.Error("with nothing configured the pipe must refuse")
	}
}

func writeTemp(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "map.json")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}
