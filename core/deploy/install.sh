#!/usr/bin/env bash
# Runs on the shared server (sent by .github/workflows/core-deploy.yml). Installs Novenique Core, the accounts service,
# next to the games without touching their code or data:
#   - its own Node in /opt/novenique-node, code in /opt/novenique/core, service novenique-core on 127.0.0.1:8200
#   - settings and secrets in /etc/novenique (made once on the server; never in the repo or in chat)
#   - a database account of its own in Palasora's PocketBase (the shared store), and Core's own nv_* tables
#   - its web address in the shared Caddy: accounts.noveniqe.com once that name points here, and always the spare
#     accounts.<server-ip>.sslip.io
# Optional keys arrive in /tmp/novenique-core-keys.env (from GitHub secrets) and are moved into the env file.
# Safe to run again.
set -euo pipefail
APP=/opt/novenique/core NODE_DIR=/opt/novenique-node ETC=/etc/novenique ENVF=/etc/novenique/core.env PORT=8200 NODE_V=v22.11.0
HOST_IP=${HOST_IP:?}
SPARE="accounts.${HOST_IP//./-}.sslip.io" MAIN_DNS=accounts.noveniqe.com

# ---- system user, Node, code ----
id novenique >/dev/null 2>&1 || sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin novenique
case "$(uname -m)" in aarch64|arm64) NARCH=arm64 ;; *) NARCH=x64 ;; esac
if [ "$("$NODE_DIR/bin/node" --version 2>/dev/null)" != "$NODE_V" ]; then
  curl -fsSL "https://nodejs.org/dist/$NODE_V/node-$NODE_V-linux-$NARCH.tar.xz" -o /tmp/nv-node.tar.xz
  sudo rm -rf "$NODE_DIR" && sudo mkdir -p "$NODE_DIR" && sudo tar -xJf /tmp/nv-node.tar.xz -C "$NODE_DIR" --strip-components=1 && rm -f /tmp/nv-node.tar.xz
fi
sudo rm -rf "$APP.new" && sudo mkdir -p "$APP.new" && sudo tar -xzf /tmp/novenique-core.tgz -C "$APP.new" && rm -f /tmp/novenique-core.tgz
sudo rm -rf "$APP.old"; [ -d "$APP" ] && sudo mv "$APP" "$APP.old"; sudo mv "$APP.new" "$APP"; sudo rm -rf "$APP.old"
sudo chown -R root:root "$APP" && sudo chmod -R go-w "$APP"

# ---- settings: secrets are made once; addresses and optional keys follow every deploy ----
sudo install -d -m 750 -o root -g novenique "$ETC" "$ETC/clients"
r() { openssl rand -hex 24; }
if ! sudo test -f "$ENVF"; then
  sudo install -m 640 -o root -g novenique /dev/null "$ENVF"
  sudo tee "$ENVF" >/dev/null <<ENV
# Novenique Core on this server. Made by core/deploy/install.sh; secrets stay here (never in the repo or in chat).
CORE_ENV=production
CORE_SECRET=$(openssl rand -hex 32)
CORE_HOST=127.0.0.1
CORE_PORT=$PORT
CORE_REALM_SLUG=palavva
CORE_CLIENTS_FILE=$APP/deploy/clients.json
CORE_CLIENT_SECRETS_DIR=$ETC/clients
PB_URL=http://127.0.0.1:8190
PB_CORE_EMAIL=core@novenique.internal
PB_CORE_PASSWORD=$(r)
MAIL_PROVIDER=off
STAFF_MFA_REQUIRED=true
ENV
fi
setkv() { sudo sed -i "/^$1=/d" "$ENVF"; printf '%s=%s\n' "$1" "$2" | sudo tee -a "$ENVF" >/dev/null; }
NAMES=("$SPARE")
[ "$(getent ahostsv4 "$MAIN_DNS" 2>/dev/null | awk 'NR==1{print $1}')" = "$HOST_IP" ] && NAMES=("$MAIN_DNS" "$SPARE")
setkv CORE_PUBLIC_URL "https://${NAMES[0]}"
if [ -f /tmp/novenique-core-keys.env ]; then
  while IFS='=' read -r k v; do [ -n "$v" ] && setkv "$k" "$v"; done < <(grep -E '^(GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|RESEND_API_KEY|BREVO_API_KEY|MAIL_FROM|SMTP_HOST|SMTP_PORT|SMTP_USER|SMTP_PASS|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET)=' /tmp/novenique-core-keys.env || true)
  rm -f /tmp/novenique-core-keys.env
fi
# Payments: one Stripe account for every game. Until the noveniqe repo has its own Stripe secrets, Core uses the ones Agent
# Grand Prix was given (same account, same webhook), so the pass keeps selling when it moves into Core.
for k in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET; do
  if ! sudo grep -q "^$k=." "$ENVF" && sudo test -f /etc/agent-grand-prix.env; then
    v=$(sudo grep "^$k=" /etc/agent-grand-prix.env | head -1 | cut -d= -f2- | tr -d ' \r\n' || true)
    if [ -n "$v" ]; then setkv "$k" "$v"; fi
  fi
done
if sudo grep -q '^SMTP_PASS=.' "$ENVF" && sudo grep -q '^SMTP_HOST=.' "$ENVF"; then setkv MAIL_PROVIDER smtp
elif sudo grep -q '^RESEND_API_KEY=.' "$ENVF"; then setkv MAIL_PROVIDER resend; elif sudo grep -q '^BREVO_API_KEY=.' "$ENVF"; then setkv MAIL_PROVIDER brevo; fi

# One secret per game. Core reads every file here; each game gets its own copy, readable only by that game's service.
for id in $(python3 -c "import json;print(' '.join(c['id'] for c in json.load(open('$APP/deploy/clients.json'))['clients']))"); do
  f="$ETC/clients/$id.env"
  if ! sudo test -f "$f"; then sudo install -m 640 -o root -g novenique /dev/null "$f"; printf 'NOVENIQUE_CLIENT_SECRET=%s\n' "$(openssl rand -hex 32)" | sudo tee "$f" >/dev/null; fi
done
if getent group palasora >/dev/null; then
  { echo "NOVENIQUE_URL=https://${NAMES[0]}"; echo 'NOVENIQUE_CLIENT_ID=palasora'; sudo grep '^NOVENIQUE_CLIENT_SECRET=' "$ETC/clients/palasora.env"; } \
    | sudo install -m 640 -o root -g palasora /dev/stdin /etc/palasora-novenique.env
fi

# ---- Core's own account in the shared store ----
sudo test -f /etc/palasora.env || { echo 'Palasora (the shared store) is not installed on this server yet.'; exit 1; }
sudo "$NODE_DIR/bin/node" "$APP/deploy/pb-user.mjs" /etc/palasora.env "$ENVF"

# ---- service ----
sudo tee /etc/systemd/system/novenique-core.service >/dev/null <<UNIT
[Unit]
Description=Novenique Core (accounts for every Novenique game, loopback only)
After=network-online.target palasora-pb.service
Wants=network-online.target
[Service]
User=novenique
Group=novenique
EnvironmentFile=$ENVF
WorkingDirectory=$APP
ExecStart=$NODE_DIR/bin/node server.mjs
Restart=always
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
MemoryHigh=200M
MemoryMax=256M
CPUWeight=100
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable novenique-core >/dev/null
sudo systemctl restart novenique-core
for i in $(seq 1 60); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/health" 2>/dev/null && break; sleep 1; done

# ---- web address in the shared Caddy ----
sudo tee /etc/caddy/sites/novenique-accounts.caddy >/dev/null <<CADDY
$(IFS=,; echo "${NAMES[*]}" | sed 's/,/, /g') {
	encode zstd gzip
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy 127.0.0.1:$PORT
}
CADDY
sudo /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
sudo systemctl reload caddy

printf '%-16s %s\n' novenique-core "$(systemctl is-active novenique-core)"
curl -fsS "http://127.0.0.1:$PORT/health"; echo
echo "Addresses: ${NAMES[*]}"
