#!/usr/bin/env bash
# End-to-end: a real ssh client -> the relay -> a stateless origin -> frames back.
# This is the only test that proves the whole premise, so CI runs it on every push.
set -euo pipefail
set +m  # quiet job-control chatter when the trap kills background servers

cd "$(dirname "$0")/.."
PORT_ORIGIN=${PORT_ORIGIN:-8787}
PORT_SSH=${PORT_SSH:-2222}
TMP=$(mktemp -d)
trap 'kill ${ORIGIN_PID:-} ${RELAY_PID:-} 2>/dev/null || true; rm -rf "$TMP"' EXIT

echo "== starting origin on :$PORT_ORIGIN"
bun packages/cli/src/bin.ts serve examples/hello/app.ts --port "$PORT_ORIGIN" >"$TMP/origin.log" 2>&1 &
ORIGIN_PID=$!

echo "== starting relay on :$PORT_SSH"
( cd relay && go run . \
    --addr "127.0.0.1:$PORT_SSH" \
    --origin "http://127.0.0.1:$PORT_ORIGIN" \
    --app-id e2e --allow-private --seed ci-seed -v ) >"$TMP/relay.log" 2>&1 &
RELAY_PID=$!

for _ in $(seq 1 60); do
  if nc -z 127.0.0.1 "$PORT_ORIGIN" 2>/dev/null && nc -z 127.0.0.1 "$PORT_SSH" 2>/dev/null; then break; fi
  sleep 1
done
nc -z 127.0.0.1 "$PORT_ORIGIN" || { echo "origin never came up"; cat "$TMP/origin.log"; exit 1; }
nc -z 127.0.0.1 "$PORT_SSH"    || { echo "relay never came up";  cat "$TMP/relay.log";  exit 1; }

# A throwaway key, so auth never falls back to an interactive prompt that would
# eat our keystrokes.
ssh-keygen -q -t ed25519 -f "$TMP/key" -N "" -C e2e

echo "== driving a session over ssh"
{ printf 'j'; sleep 2; printf 'q'; sleep 2; } | ssh -tt \
  -p "$PORT_SSH" \
  -i "$TMP/key" \
  -o IdentitiesOnly=yes \
  -o PreferredAuthentications=publickey \
  -o NumberOfPasswordPrompts=0 \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR \
  e2e@127.0.0.1 >"$TMP/out.raw" 2>"$TMP/out.err" || true

bytes=$(wc -c <"$TMP/out.raw" | tr -d ' ')
echo "== received $bytes bytes of ANSI"
[ "$bytes" -gt 500 ] || { echo "FAIL: suspiciously little output"; cat "$TMP/out.err"; cat "$TMP/relay.log"; exit 1; }

fail=0
for needle in "lithe" "Why this exists" "overview" "80" ; do
  if grep -aq "$needle" "$TMP/out.raw"; then
    echo "  ok: saw '$needle'"
  else
    echo "  FAIL: never saw '$needle'"
    fail=1
  fi
done

grep -aq "alternate screen\|\[?1049h" "$TMP/out.raw" && echo "  ok: entered the alternate screen"
grep -q "frames=" "$TMP/relay.log" && echo "  ok: relay logged a completed session: $(grep -o 'frames=[0-9]* dur=[^ ]*' "$TMP/relay.log" | tail -1)"

if [ "$fail" -ne 0 ]; then
  echo "--- relay log ---"; cat "$TMP/relay.log"
  echo "--- origin log ---"; cat "$TMP/origin.log"
  exit 1
fi
echo "== e2e passed"
