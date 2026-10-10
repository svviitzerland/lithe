// lithe relay — terminates SSH and speaks the lithe frame protocol to a
// serverless origin.
//
// This is the only long-lived process in the stack, and it is deliberately
// boring: no state, no database, no per-app configuration. A single instance
// can serve every app that publishes a _lithe DNS record.
package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gliderlabs/ssh"
	gossh "golang.org/x/crypto/ssh"
)

func main() {
	var (
		addr         = flag.String("addr", envOr("LITHE_ADDR", ":2222"), "address to listen on")
		origin       = flag.String("origin", os.Getenv("LITHE_ORIGIN"), "serve a single app at this URL (ignores the username)")
		appID        = flag.String("app-id", envOr("LITHE_APP_ID", ""), "app name reported to a single-app origin")
		routesPath   = flag.String("routes", os.Getenv("LITHE_ROUTES"), "JSON file mapping ssh username -> origin URL")
		seed         = flag.String("seed", os.Getenv("LITHE_SEED"), "host key seed; same seed = same fingerprint forever")
		useProbe     = flag.Bool("probe", true, "find an app by asking its hostname, so nothing needs registering")
		allowPrivate = flag.Bool("allow-private", false, "allow http:// and private-network origins (local development)")
		maxRPS       = flag.Int("max-rps", 30, "max origin requests per second per session")
		coalesce     = flag.Duration("coalesce", 8*time.Millisecond, "input batching window")
		idle         = flag.Duration("idle", 10*time.Minute, "disconnect after this much inactivity")
		maxDur       = flag.Duration("max-session", 4*time.Hour, "hard cap on one session")
		timeout      = flag.Duration("timeout", 10*time.Second, "origin request timeout")
		pipe         = flag.String("pipe", os.Getenv("LITHE_PIPE"), "dumb-pipe mode: splice TCP onto this app's WebSocket and parse nothing")
		pipeMap      = flag.String("pipe-map", os.Getenv("LITHE_PIPE_MAP"), "JSON file mapping destination IP -> app origin, for one address per app")
		verbose      = flag.Bool("v", false, "log one line per session")
		showKey      = flag.Bool("print-fingerprint", false, "print the host key fingerprint and exit")
	)
	flag.Parse()

	routes, err := LoadRoutes(*routesPath)
	if err != nil {
		log.Fatalf("routes: %v", err)
	}

	// Pipe mode terminates nothing, so there is no host key, no auth and no
	// discovery — just bytes. It is the only mode where a stock `ssh app.com`
	// works with nothing configured on the client.
	if *pipe != "" || *pipeMap != "" {
		byAddr, err := LoadPipeMap(*pipeMap)
		if err != nil {
			log.Fatalf("pipe-map: %v", err)
		}
		ln, err := net.Listen("tcp", *addr)
		if err != nil {
			log.Fatal(err)
		}
		log.Printf("lithe pipe on %s — terminating nothing", *addr)
		if *pipe != "" {
			log.Printf("  all connections -> %s", *pipe)
		}
		for ip, origin := range byAddr {
			log.Printf("  %s -> %s", ip, origin)
		}
		client := &http.Client{Transport: &http.Transport{
			MaxIdleConns:      256,
			IdleConnTimeout:   90 * time.Second,
			ForceAttemptHTTP2: true,
		}}
		log.Fatal(ServePipe(ln, PipeConfig{
			Origin:    *pipe,
			ByAddress: byAddr,
			Timeout:   *timeout,
			Verbose:   *verbose,
		}, client))
	}

	label := "relay"
	if *origin != "" && *appID != "" {
		label = *appID
	}
	signer, err := DeriveHostKey(*seed, label)
	if err != nil {
		log.Fatalf("host key: %v", err)
	}
	if *showKey {
		fmt.Println(Fingerprint(signer))
		return
	}
	if *seed == "" {
		log.Printf("warning: no --seed given, host key is random for this process")
		log.Printf("         clients will see a host key warning after every restart")
	}

	res := &Resolver{
		DefaultOrigin: *origin,
		AppID:         *appID,
		Static:        routes,
		Probe:         *useProbe && *origin == "",
		AllowPrivate:  *allowPrivate,
	}

	relay := NewRelay(Config{
		Addr:        *addr,
		MaxRPS:      *maxRPS,
		Idle:        *idle,
		MaxDuration: *maxDur,
		Coalesce:    *coalesce,
		Timeout:     *timeout,
		Verbose:     *verbose,
	}, res)

	srv := &ssh.Server{
		Addr:    *addr,
		Handler: relay.Handle,
		// Any key is welcome: the fingerprint becomes the app's stable user id.
		// Apps that need real auth check the fingerprint themselves.
		PublicKeyHandler: func(ssh.Context, ssh.PublicKey) bool { return true },
		KeyboardInteractiveHandler: func(ssh.Context, gossh.KeyboardInteractiveChallenge) bool {
			return true
		},
		IdleTimeout: *idle + time.Minute,
		MaxTimeout:  *maxDur + time.Minute,
	}
	srv.AddHostKey(signer)

	mode := "discovery by hostname"
	if !*useProbe {
		mode = "static routes only"
	}
	if *origin != "" {
		mode = "single origin " + *origin
	} else if len(routes) > 0 {
		mode = fmt.Sprintf("%d static route(s)", len(routes))
	}
	log.Printf("lithe relay on %s — %s", *addr, mode)
	log.Printf("host key %s", Fingerprint(signer))
	if *origin != "" {
		host, port := "127.0.0.1", strings.TrimPrefix(*addr, ":")
		if i := strings.LastIndex(*addr, ":"); i > 0 {
			host, port = (*addr)[:i], (*addr)[i+1:]
		}
		log.Printf("try: ssh -p %s app@%s", port, host)
	}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
