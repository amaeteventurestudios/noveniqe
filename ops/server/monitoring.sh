#!/usr/bin/env bash
# Runs on the shared server from ops/server/install.sh. Two watchers for every product, both open source:
#   - Uptime Kuma (MIT): checks every site each minute and keeps the history, at https://status.<server>.sslip.io
#     (and status.noveniqe.com once its DNS points here), behind the owner's password;
#   - Umami (MIT): privacy-friendly visitor stats (no cookies, no personal data) for the sites and apps, at
#     https://stats.<server>.sslip.io (and stats.noveniqe.com), with its own Postgres database, dumped nightly for the backup.
# Both listen on loopback only; Caddy puts them on the web. Safe to run again. Needs PUBLIC_IP; OWNER_PASSWORD is optional
# (the OWNER_PASSWORD secret in the noveniqe repo): without it both stay closed until it is added.
set -euo pipefail
: "${PUBLIC_IP:?set PUBLIC_IP}"
NODE_V=v22.11.0 NODE_DIR=/opt/novenique-node KUMA_V=2.5.8 UMAMI_V=v3.4.1
KUMA=/opt/uptime-kuma UMAMI=/opt/umami SECRETS=/etc/novenique UENV=/etc/novenique/umami.env
SPARE=$(printf '%s' "$PUBLIC_IP" | tr . -).sslip.io
case "$(uname -m)" in aarch64|arm64) NARCH=arm64 ;; *) NARCH=x64 ;; esac
export PATH="$NODE_DIR/bin:$PATH"
sudo install -d -m 755 -o root -g root "$SECRETS"
if [ "$("$NODE_DIR/bin/node" --version 2>/dev/null)" != "$NODE_V" ]; then
  curl -fsSL "https://nodejs.org/dist/$NODE_V/node-$NODE_V-linux-$NARCH.tar.xz" -o /tmp/node.tar.xz
  sudo rm -rf "$NODE_DIR" && sudo mkdir -p "$NODE_DIR" && sudo tar -xJf /tmp/node.tar.xz -C "$NODE_DIR" --strip-components=1 && rm -f /tmp/node.tar.xz
fi
command -v git >/dev/null || sudo apt-get install -y -qq git >/dev/null
svc() {  # name, description, user, workdir, command, environment
  sudo tee "/etc/systemd/system/$1.service" >/dev/null <<UNIT
[Unit]
Description=$2
After=network-online.target postgresql.service
Wants=network-online.target
[Service]
User=$3
Group=$3
WorkingDirectory=$4
ExecStart=$5
Environment=$6
Restart=always
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
MemoryMax=768M
[Install]
WantedBy=multi-user.target
UNIT
}
user() { id "$1" >/dev/null 2>&1 || sudo useradd --system --home-dir "$2" --shell /usr/sbin/nologin "$1"; sudo install -d -m 750 -o "$1" -g "$1" "$2"; }
HASH=''
if [ -n "${OWNER_PASSWORD:-}" ]; then HASH=$(/usr/local/bin/caddy hash-password --plaintext "$OWNER_PASSWORD"); fi

# ---- Uptime Kuma ----
kuma() {
  user kuma /var/lib/uptime-kuma
  if [ "$(cat "$KUMA/.version" 2>/dev/null)" != "$KUMA_V" ]; then
    # (set -e is off inside a function run with ||, so each step that matters stops the install itself)
    sudo rm -rf "$KUMA.new" && sudo git clone -q --depth 1 --branch "$KUMA_V" https://github.com/louislam/uptime-kuma.git "$KUMA.new" || return 1
    (cd "$KUMA.new" && sudo env PATH="$PATH" npm ci --omit=dev --no-audit --no-fund --loglevel=error && sudo env PATH="$PATH" npm run download-dist --silent) || return 1
    echo "$KUMA_V" | sudo tee "$KUMA.new/.version" >/dev/null || return 1
    sudo rm -rf "$KUMA.old"; [ -d "$KUMA" ] && sudo mv "$KUMA" "$KUMA.old"; sudo mv "$KUMA.new" "$KUMA"; sudo rm -rf "$KUMA.old"
  fi
  svc uptime-kuma "Uptime Kuma (loopback only)" kuma "$KUMA" "$NODE_DIR/bin/node server/server.js" \
    "UPTIME_KUMA_HOST=127.0.0.1 UPTIME_KUMA_PORT=3001 DATA_DIR=/var/lib/uptime-kuma/ NODE_ENV=production"
  sudo systemctl daemon-reload && sudo systemctl enable uptime-kuma >/dev/null && sudo systemctl restart uptime-kuma
  echo "Uptime Kuma $KUMA_V: $(systemctl is-active uptime-kuma)"
}

# ---- Umami (and its Postgres) ----
umami() {
  if ! command -v psql >/dev/null; then sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql >/dev/null || return 1; fi
  sudo systemctl enable --now postgresql >/dev/null || return 1
  if ! sudo test -f "$UENV"; then
    sudo install -m 600 -o root -g root /dev/null "$UENV"
    printf 'DB_PASSWORD=%s\nAPP_SECRET=%s\nADMIN_PASSWORD=umami\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 32)" | sudo tee "$UENV" >/dev/null
  fi
  get() { sudo grep "^$1=" "$UENV" | head -1 | cut -d= -f2-; }
  put() { sudo sed -i "/^$1=/d" "$UENV"; printf '%s=%s\n' "$1" "$2" | sudo tee -a "$UENV" >/dev/null; }
  local DBP; DBP=$(get DB_PASSWORD)
  sudo -u postgres psql -qtAc "select 1 from pg_roles where rolname='umami'" | grep -q 1 || sudo -u postgres psql -qc "create role umami login password '$DBP'"
  sudo -u postgres psql -qtAc "select 1 from pg_database where datname='umami'" | grep -q 1 || sudo -u postgres createdb -O umami umami || return 1
  local DBURL="postgresql://umami:$DBP@127.0.0.1:5432/umami"
  user umami /var/lib/umami
  if [ "$(cat "$UMAMI/.version" 2>/dev/null)" != "$UMAMI_V" ]; then
    sudo rm -rf "$UMAMI.new" && sudo git clone -q --depth 1 --branch "$UMAMI_V" https://github.com/umami-software/umami.git "$UMAMI.new" || return 1
    sudo chown -R umami:umami "$UMAMI.new"
    (cd "$UMAMI.new" && sudo -u umami env PATH="$PATH" HOME=/var/lib/umami COREPACK_ENABLE_DOWNLOAD_PROMPT=0 DATABASE_URL="$DBURL" sh -c 'corepack pnpm install --frozen-lockfile --silent && corepack pnpm run build') || return 1
    echo "$UMAMI_V" | sudo tee "$UMAMI.new/.version" >/dev/null || return 1
    sudo systemctl stop umami 2>/dev/null || true
    sudo rm -rf "$UMAMI.old"; [ -d "$UMAMI" ] && sudo mv "$UMAMI" "$UMAMI.old"; sudo mv "$UMAMI.new" "$UMAMI"; sudo rm -rf "$UMAMI.old"
  fi
  svc umami "Umami visitor stats (loopback only)" umami "$UMAMI" "$NODE_DIR/bin/node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3002" \
    "DATABASE_URL=$DBURL APP_SECRET=$(get APP_SECRET) DISABLE_TELEMETRY=1 NODE_ENV=production"
  sudo chmod 600 /etc/systemd/system/umami.service
  sudo systemctl daemon-reload && sudo systemctl enable umami >/dev/null && sudo systemctl restart umami
  for i in $(seq 1 60); do curl -fsS -o /dev/null http://127.0.0.1:3002/api/heartbeat 2>/dev/null && break; sleep 2; done
  # Never leave the starting password: it becomes the owner's password, or a random one until that secret exists.
  local cur new tok
  cur=$(get ADMIN_PASSWORD); new="${OWNER_PASSWORD:-}"; [ -n "$new" ] || [ "$cur" != umami ] || new=$(openssl rand -hex 16)
  login() { curl -fsS -H 'content-type: application/json' -d "$(python3 -c 'import json,sys; print(json.dumps({"username": "admin", "password": sys.argv[1]}))' "$1")" http://127.0.0.1:3002/api/auth/login | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null || true; }
  tok=$(login "$cur")
  if [ -n "$tok" ] && [ -n "$new" ] && [ "$new" != "$cur" ]; then
    curl -fsS -o /dev/null -H "authorization: Bearer $tok" -H 'content-type: application/json' -d "$(python3 -c 'import json,sys; print(json.dumps({"currentPassword": sys.argv[1], "newPassword": sys.argv[2]}))' "$cur" "$new")" http://127.0.0.1:3002/api/me/password && put ADMIN_PASSWORD "$new" && cur="$new"
  fi
  # One website entry per product; their ids go to the products' installs through this file.
  tok=$(login "$cur")
  if [ -n "$tok" ]; then
    for site in "JISST jisst.app Jisst" "AGP agentgrandprix.com Agent-Grand-Prix" "PALASORA palasora.com Palasora"; do
      set -- $site
      [ -n "$(get "SITE_$1")" ] && continue
      id=$(curl -fsS -H "authorization: Bearer $tok" -H 'content-type: application/json' -d "{\"name\":\"${3//-/ }\",\"domain\":\"$2\"}" http://127.0.0.1:3002/api/websites | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' || true)
      [ -n "$id" ] && put "SITE_$1" "$id"
    done
  fi
  put URL "https://stats.$SPARE"
  # the public part (where the tracker lives and the site ids) for the products' installs
  sudo grep -E '^(URL|SITE_[A-Z]+)=' "$UENV" | sudo tee "$SECRETS/umami.public" >/dev/null; sudo chmod 644 "$SECRETS/umami.public"
  # nightly dump for the backup (03:20 UTC, before the 03:30 backup)
  sudo install -d -m 700 -o postgres -g postgres /var/backups/novenique-umami
  sudo tee /etc/systemd/system/novenique-umami-dump.service >/dev/null <<'UNIT'
[Unit]
Description=Umami database dump for the nightly backup
[Service]
Type=oneshot
User=postgres
ExecStart=/bin/sh -c 'pg_dump umami | gzip > /var/backups/novenique-umami/umami.sql.gz.new && mv /var/backups/novenique-umami/umami.sql.gz.new /var/backups/novenique-umami/umami.sql.gz'
Nice=10
UNIT
  sudo tee /etc/systemd/system/novenique-umami-dump.timer >/dev/null <<'UNIT'
[Unit]
Description=Umami database dump (schedule)
[Timer]
OnCalendar=*-*-* 03:20:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
UNIT
  sudo systemctl daemon-reload && sudo systemctl enable --now novenique-umami-dump.timer >/dev/null
  echo "Umami $UMAMI_V: $(systemctl is-active umami)"
}

kuma || echo "::warning::Uptime Kuma did not install this time; everything else is unaffected."
umami || echo "::warning::Umami did not install this time; everything else is unaffected."

# ---- on the web, through their own Caddy site files ----
[ -d /etc/caddy/sites ] || { echo 'No shared Caddy yet; the watchers run on loopback only.'; exit 0; }
site() {  # file, names, port, protect-everything
  {
    echo "$2 {"
    echo "	encode zstd gzip"
    if [ "$4" = all ]; then
      if [ -n "$HASH" ]; then printf '\tbasic_auth {\n\t\towner %s\n\t}\n' "$HASH"; else printf '\trespond "Add the OWNER_PASSWORD secret in the noveniqe repo, then run Server safety (deploy) again." 403\n'; fi
    fi
    echo "	reverse_proxy 127.0.0.1:$3"
    echo "}"
  } | sudo tee "/etc/caddy/sites/$1" >/dev/null
}
# the noveniqe.com names join once their DNS points at this server (until then Caddy would keep failing to get them a certificate)
names() { local n="$1.$SPARE"; getent ahostsv4 "$1.noveniqe.com" 2>/dev/null | grep -q "^$PUBLIC_IP " && n="$n, $1.noveniqe.com"; echo "$n"; }
site status.caddy "$(names status)" 3001 all
site stats.caddy "$(names stats)" 3002 open
sudo /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null && sudo systemctl reload caddy
echo "Status page: https://status.$SPARE   Visitor stats: https://stats.$SPARE"
