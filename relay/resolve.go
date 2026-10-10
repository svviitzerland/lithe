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
// Four strategies, in order:
//  1. --origin: every connection goes to one endpoint (self-hosting a single app)
//  2. --routes file: a static name -> origin map
//  3. DNS: TXT at _lithe.<username> names the origin. Authoritative, and the
//     only option if your endpoint lives somewhere other than the hostname.
//  4. Probe: GET https://<username>/<well-known path> and accept it if it
//     answers with a lithe manifest. This is what makes a platform-assigned
//     hostname work — you cannot publish DNS under vercel.app or workers.dev,
//     but you can deploy there and be found by convention.
type Resolver struct {
	DefaultOrigin string
	AppID         string
	Static        map[string]string
	DNS           bool
	Probe         bool
	AllowPrivate  bool
	TTL           time.Duration
	Client        *http.Client

	mu    sync.Mutex
	cache map[string]cached
}

// Where an app is expected to live when nothing says otherwise.
var probePaths = []string{"/api/tui", "/tui", "/api/lithe", "/"}

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

	if !r.DNS && !r.Probe {
		return "", "", fmt.Errorf("unknown app %q", user)
	}
	if !domainish.MatchString(user) {
		return "", "", fmt.Errorf("%q is not a domain; connect as ssh your-domain.com@<relay>", user)
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

	o, err := r.discover(ctx, user)
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

// discover tries the DNS record first, then well-known paths on the hostname.
func (r *Resolver) discover(ctx context.Context, domain string) (string, error) {
	var dnsErr error
	if r.DNS {
		o, err := lookupOrigin(ctx, domain)
		if err == nil {
			return o, nil
		}
		dnsErr = err
	}
	if !r.Probe {
		return "", dnsErr
	}
	o, err := r.probe(ctx, domain)
	if err == nil {
		return o, nil
	}
	if dnsErr != nil {
		return "", fmt.Errorf("%v, and %v", dnsErr, err)
	}
	return "", err
}

// probe asks the hostname itself where the app is. A candidate counts only if
// it returns a lithe manifest, so a relay cannot be pointed at a third party
// that has not opted in.
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
	return "", fmt.Errorf("probed %s://%s%v but found no lithe app", scheme, domain, probePaths)
}

// lookupOrigin reads  _lithe.<domain>  TXT  "v=lithe1; origin=https://..."
func lookupOrigin(ctx context.Context, domain string) (string, error) {
	recs, err := net.DefaultResolver.LookupTXT(ctx, "_lithe."+domain)
	if err != nil {
		return "", fmt.Errorf("no _lithe.%s TXT record found", domain)
	}
	for _, rec := range recs {
		fields := map[string]string{}
		for _, part := range strings.Split(rec, ";") {
			kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
			if len(kv) == 2 {
				fields[strings.ToLower(kv[0])] = strings.TrimSpace(kv[1])
			}
		}
		if fields["v"] != "lithe1" {
			continue
		}
		if o := fields["origin"]; o != "" {
			return o, nil
		}
	}
	return "", fmt.Errorf("_lithe.%s has no valid v=lt1 record", domain)
}

// validate keeps the relay from being turned into an open proxy into private
// networks by whoever controls a TXT record.
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
