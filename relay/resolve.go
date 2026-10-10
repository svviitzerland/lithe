package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

var domainish = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`)

type cached struct {
	origin string
	at     time.Time
}

// Resolver turns an SSH username into an origin URL.
//
// There is nothing to register and nothing to publish. If your app answers at a
// hostname — the one the platform gave you, or your own domain added in the
// Vercel or Cloudflare dashboard — the relay finds it by asking that hostname
// directly:
//
//	GET https://<hostname>/_lithe/ssh   (and /api/tui, /tui, /)
//
// A candidate counts only when it replies with a lithe manifest, so a relay
// cannot be aimed at a third party that has not deployed one.
type Resolver struct {
	// DefaultOrigin serves one app and ignores the username.
	DefaultOrigin string
	AppID         string
	// Static pins specific usernames, for operators who want an allowlist.
	Static       map[string]string
	Probe        bool
	AllowPrivate bool
	TTL          time.Duration
	Client       *http.Client

	mu    sync.Mutex
	cache map[string]cached
}

// Where an app lives when nothing says otherwise. The first is the convention
// for a lithe deployment; the rest cover apps mounted under a framework's
// routing.
var probePaths = []string{"/_lithe/ssh", "/api/tui", "/tui", "/"}

func LoadRoutes(path string) (map[string]string, error) {
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
	return m, nil
}

func (r *Resolver) Resolve(ctx context.Context, user string) (app string, origin string, err error) {
	user = strings.ToLower(strings.TrimSpace(user))

	if r.DefaultOrigin != "" {
		app = r.AppID
		if app == "" {
			app = "app"
		}
		return app, r.DefaultOrigin, r.validate(r.DefaultOrigin)
	}

	if o, ok := r.Static[user]; ok {
		return user, o, r.validate(o)
	}

	if !r.Probe {
		return "", "", fmt.Errorf("unknown app %q", user)
	}
	if !domainish.MatchString(user) {
		return "", "", fmt.Errorf("%q is not a hostname; connect as ssh your-app.com@<relay>", user)
	}

	r.mu.Lock()
	if r.cache == nil {
		r.cache = map[string]cached{}
	}
	if c, ok := r.cache[user]; ok && time.Since(c.at) < r.ttl() {
		r.mu.Unlock()
		return user, c.origin, r.validate(c.origin)
	}
	r.mu.Unlock()

	o, err := r.probe(ctx, user)
	if err != nil {
		return "", "", err
	}
	if err := r.validate(o); err != nil {
		return "", "", err
	}
	r.mu.Lock()
	r.cache[user] = cached{origin: o, at: time.Now()}
	r.mu.Unlock()
	return user, o, nil
}

func (r *Resolver) ttl() time.Duration {
	if r.TTL == 0 {
		return 60 * time.Second
	}
	return r.TTL
}

// probe asks the hostname itself where the app is.
func (r *Resolver) probe(ctx context.Context, domain string) (string, error) {
	client := r.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	scheme := "https"
	if r.AllowPrivate {
		scheme = "http"
	}
	for _, path := range probePaths {
		candidate := scheme + "://" + domain + path
		if err := r.validate(candidate); err != nil {
			continue
		}
		cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		req, err := http.NewRequestWithContext(cctx, http.MethodGet, candidate, nil)
		if err != nil {
			cancel()
			continue
		}
		req.Header.Set("accept", "application/json")
		req.Header.Set("user-agent", "lithe-relay/0.1 (discovery)")
		res, err := client.Do(req)
		if err != nil {
			cancel()
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
		res.Body.Close()
		cancel()
		if res.StatusCode != http.StatusOK {
			continue
		}
		var m struct {
			Lithe *int `json:"lithe"`
		}
		if json.Unmarshal(body, &m) == nil && m.Lithe != nil {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("no lithe app answered at %s://%s (tried %s)", scheme, domain, strings.Join(probePaths, ", "))
}

// validate keeps the relay from being turned into an open proxy into private
// networks by whoever controls a hostname.
func (r *Resolver) validate(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("bad origin URL: %w", err)
	}
	if u.Scheme != "https" && !(r.AllowPrivate && u.Scheme == "http") {
		return fmt.Errorf("origin must be https (got %q)", u.Scheme)
	}
	if r.AllowPrivate {
		return nil
	}
	host := u.Hostname()
	ips, err := net.LookupIP(host)
	if err != nil {
		return fmt.Errorf("cannot resolve origin host %q", host)
	}
	for _, ip := range ips {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
			return fmt.Errorf("origin %q resolves to a private address", host)
		}
	}
	return nil
}
