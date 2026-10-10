#!/usr/bin/env bash
# Turns a fresh Linux box into a lithe pipe on port 22.
#
# Port 22 is already taken by the machine's own sshd, so the first thing this
# does is move administrative ssh to 2200 — and it verifies sshd came back
# before touching anything else, so a mistake cannot lock you out.
set -euo pipefail

ORIGIN=${1:?usage: setup-pipe.sh https://my-app.example [admin-port]}
ADMIN_PORT=${2:-2200}

say() { printf '\n== %s\n' "$*"; }

say "moving administrative sshd to port $ADMIN_PORT"
if ! grep -q "^Port $ADMIN_PORT" /etc/ssh/sshd_config; then
  printf '\n# moved aside so the lithe pipe can own :22\nPort %s\n' "$ADMIN_PORT" | sudo tee -a /etc/ssh/sshd_config >/dev/null
fi
sudo sed -i 's/^Port 22$//' /etc/ssh/sshd_config || true
# Some distros also socket-activate sshd on :22.
sudo systemctl disable --now ssh.socket 2>/dev/null || true
sudo systemctl restart ssh 2>/dev/null || sudo systemctl restart sshd
sleep 2
if ! ss -lnt | grep -q ":$ADMIN_PORT "; then
  echo "sshd is not listening on $ADMIN_PORT — aborting before port 22 is touched"
  exit 1
fi
echo "   sshd is on $ADMIN_PORT; keep this session open until you have tested it"

say "installing the pipe"
sudo install -m 0755 ./lithe-relay /usr/local/bin/lithe-relay
printf 'LITHE_PIPE_ORIGIN=%s\n' "$ORIGIN" | sudo tee /etc/default/lithe-pipe >/dev/null
sudo install -m 0644 ./lithe-pipe.service /etc/systemd/system/lithe-pipe.service
sudo systemctl daemon-reload
sudo systemctl enable --now lithe-pipe

sleep 2
say "status"
sudo systemctl is-active lithe-pipe
ss -lnt | grep -E ':22 |:'"$ADMIN_PORT"' ' || true

cat <<MSG

Done. Point a DNS record at this machine — an A record, DNS only, not proxied,
because a CDN proxy will not carry port 22 — and then anyone can run:

  ssh your-subdomain.example.com

Administrative access is now on port $ADMIN_PORT:  ssh -p $ADMIN_PORT user@<this host>
MSG
