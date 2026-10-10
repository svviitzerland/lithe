#!/usr/bin/env bash
# The relay-less path, end to end: a real `ssh` client against an SSH server
# written in TypeScript. Once over plain TCP, once tunnelled through a
# WebSocket, which is how it reaches a serverless function.
set -euo pipefail
set +m

cd "$(dirname "$0")/.."
TCP_PORT=${TCP_PORT:-2200}
WS_PORT=${WS_PORT:-8790}
TMP=$(mktemp -d)
trap 'kill ${TCP_PID:-} ${WS_PID:-} 2>/dev/null || true; rm -rf "$TMP"' EXIT

ssh-keygen -q -t ed25519 -f "$TMP/key" -N "" -C e2e-ssh

wait_port() {
  for _ in $(seq 1 60); do
    nc -z 127.0.0.1 "$1" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

# Drives a session and checks what the client got back.
check() {
  local label=$1 out=$2 err=$3
  local bytes
  bytes=$(wc -c <"$out" | tr -d ' ')
  echo "   $label: $bytes bytes"
  [ "$bytes" -gt 500 ] || { echo "   FAIL: too little output"; cat "$err"; return 1; }
  grep -aq "Why this exists" "$out" || { echo "   FAIL: the app did not render"; return 1; }
  grep -aq '\[?1049h' "$out" || { echo "   FAIL: never entered the alternate screen"; return 1; }
  grep -q 'using "publickey"' "$err" || { echo "   FAIL: publickey auth was not used"; grep -i auth "$err"; return 1; }
  echo "   ok: rendered, alternate screen, publickey auth"
}

echo "== ssh over plain tcp"
PORT=$TCP_PORT bun scripts/fixtures/ssh-tcp.ts >"$TMP/tcp.log" 2>&1 &
TCP_PID=$!
wait_port "$TCP_PORT" || { echo "server never came up"; cat "$TMP/tcp.log"; exit 1; }

{ sleep 2; printf 'jj'; sleep 2; printf 'q'; sleep 2; } | ssh -tt \
  -p "$TCP_PORT" -i "$TMP/key" \
  -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null -o LogLevel=DEBUG1 \
  e2e@127.0.0.1 >"$TMP/tcp.out" 2>"$TMP/tcp.err" || true
check "tcp" "$TMP/tcp.out" "$TMP/tcp.err"
grep -q "host key SHA256:" "$TMP/tcp.log" && echo "   ok: derived host key $(grep -o 'SHA256:[^ ]*' "$TMP/tcp.log" | head -1)"
grep -aq "Server host key: ssh-ed25519" "$TMP/tcp.err" && echo "   ok: the client verified that host key signature"

echo "== ssh tunnelled through a websocket"
PORT=$WS_PORT bun scripts/fixtures/ssh-ws.ts >"$TMP/ws.log" 2>&1 &
WS_PID=$!
wait_port "$WS_PORT" || { echo "server never came up"; cat "$TMP/ws.log"; exit 1; }

{ sleep 2; printf 'jj'; sleep 2; printf 'q'; sleep 2; } | bun packages/cli/src/bin.ts ssh 127.0.0.1 \
  --insecure --ws-port "$WS_PORT" \
  -tt -i "$TMP/key" \
  -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null -o LogLevel=DEBUG1 \
  >"$TMP/ws.out" 2>"$TMP/ws.err" || true
check "websocket" "$TMP/ws.out" "$TMP/ws.err"

echo "== the same seed gives the same host key on both transports"
# From the server logs: the client's debug output also mentions its own key.
tcp_fp=$(grep -o 'host key SHA256:[A-Za-z0-9+/]*' "$TMP/tcp.log" | head -1 | cut -d' ' -f3)
ws_fp=$(grep -o 'host key SHA256:[A-Za-z0-9+/]*' "$TMP/ws.log" | head -1 | cut -d' ' -f3)
echo "   tcp $tcp_fp"
echo "   ws  $ws_fp"
[ -n "$tcp_fp" ] && [ "$tcp_fp" = "$ws_fp" ] || { echo "   FAIL: fingerprints differ"; exit 1; }

echo "== e2e-ssh passed"
