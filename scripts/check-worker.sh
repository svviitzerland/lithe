#!/usr/bin/env bash
# Boots the example Worker on workerd (the real Cloudflare runtime, locally) and
# drives one frame through it. Catches anything that depends on Node built-ins.
set -euo pipefail
set +m

cd "$(dirname "$0")/.."
PORT=${PORT:-8799}
TMP=$(mktemp -d)
trap 'kill ${WRANGLER_PID:-} 2>/dev/null || true; rm -rf "$TMP"' EXIT

echo "== bun install (wrangler)"
bun install >/dev/null

echo "== wrangler dev on :$PORT"
( cd examples/hello && bunx wrangler dev --port "$PORT" --local --log-level warn ) >"$TMP/wrangler.log" 2>&1 &
WRANGLER_PID=$!

for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then break; fi
  sleep 1
done

manifest=$(curl -fsS "http://127.0.0.1:$PORT/" || true)
if [ -z "$manifest" ]; then
  echo "FAIL: worker never answered"; cat "$TMP/wrangler.log"; exit 1
fi
echo "   manifest: $manifest"
echo "$manifest" | grep -q '"lithe"' || { echo "FAIL: not a lithe manifest"; exit 1; }

echo "== one frame through workerd"
frame=$(curl -fsS -X POST "http://127.0.0.1:$PORT/" \
  -H 'content-type: application/json' \
  -d '{"v":1,"sid":"ci","size":[80,24],"full":true,"events":[{"t":"init"}],"ctx":{"user":"ci"}}')
echo "$frame" | grep -q '"frame"' || { echo "FAIL: no frame in response"; echo "$frame"; exit 1; }
echo "$frame" | grep -q '"session"' || { echo "FAIL: no session blob"; exit 1; }
echo "$frame" | grep -q 'Why this exists' || { echo "FAIL: app did not render"; exit 1; }
echo "   frame bytes: ${#frame}"

echo "== session round trip (gzip + hmac on workerd)"
session=$(echo "$frame" | bun -e 'const s=await Bun.stdin.text(); process.stdout.write(JSON.parse(s).session)')
vst=$(echo "$frame" | bun -e 'const s=await Bun.stdin.text(); process.stdout.write(JSON.parse(s).vst)')
second=$(curl -fsS -X POST "http://127.0.0.1:$PORT/" \
  -H 'content-type: application/json' \
  -d "{\"v\":1,\"sid\":\"ci\",\"session\":\"$session\",\"vst\":\"$vst\",\"size\":[80,24],\"events\":[{\"t\":\"key\",\"key\":\"down\"}],\"ctx\":{\"user\":\"ci\"}}")
echo "$second" | grep -q '"partial":true' || { echo "FAIL: expected a partial frame"; echo "$second"; exit 1; }
echo "   partial frame bytes: ${#second} (vs ${#frame} full)"
echo "== worker ok"
