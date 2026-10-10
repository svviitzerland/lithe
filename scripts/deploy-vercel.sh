#!/usr/bin/env bash
# Deploys an example to Vercel: the HTTP frame endpoint and the SSH endpoint.
#
# Examples here depend on the packages through the workspace protocol, which
# Vercel's installer cannot resolve, so the functions are bundled first. A real
# app installing @lithe/app from npm just runs `vercel deploy`.
set -euo pipefail
set +m

cd "$(dirname "$0")/.."
EXAMPLE=${1:-examples/hello}
NAME=${2:-lithe-hello}
OUT=".deploy/$NAME"

echo "== bundling"
rm -rf "$OUT"
mkdir -p "$OUT/api"
bun build "$EXAMPLE/api/tui.ts" --target=node --format=esm --minify --outfile "$OUT/api/tui.js"

HAS_SSH=0
if [ -f "$EXAMPLE/api/ssh.ts" ]; then
  HAS_SSH=1
  # Vercel's WebSocket helper must stay external: it is wired into the runtime.
  bun build "$EXAMPLE/api/ssh.ts" --target=node --format=esm --minify \
    --external @vercel/functions --external ws \
    --outfile "$OUT/api/ssh.js"
fi

cat > "$OUT/package.json" <<JSON
{
  "name": "$NAME",
  "private": true,
  "type": "module",
  "dependencies": {
    "@vercel/functions": "^3.9.11",
    "ws": "^8.18.0"
  }
}
JSON

if [ "$HAS_SSH" = "1" ]; then
  cat > "$OUT/vercel.json" <<'JSON'
{
  "functions": {
    "api/tui.js": { "maxDuration": 15 },
    "api/ssh.js": { "maxDuration": 300 }
  },
  "rewrites": [
    { "source": "/", "destination": "/api/tui" },
    { "source": "/_lithe/ssh", "destination": "/api/ssh" }
  ]
}
JSON
else
  cat > "$OUT/vercel.json" <<'JSON'
{
  "functions": { "api/tui.js": { "maxDuration": 15 } },
  "rewrites": [{ "source": "/", "destination": "/api/tui" }]
}
JSON
fi

for f in "$OUT"/api/*.js; do
  echo "   $(basename "$f"): $(wc -c <"$f" | tr -d ' ') bytes"
done

echo "== deploying"
bunx vercel deploy --prod --yes --cwd "$OUT" 2>&1 | tee "$OUT/.deploy.log"
url=$(grep -Eo 'https://[a-z0-9.-]+\.vercel\.app' "$OUT/.deploy.log" | tail -1)
echo
echo "== deployed: $url"
mkdir -p .deploy && echo "$url" > .deploy/last-url.txt
