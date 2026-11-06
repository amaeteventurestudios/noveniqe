#!/usr/bin/env bash
# Runs on the shared server (sent by .github/workflows/ops-deploy.yml). Installs Novenique's server safety pieces next to
# the games, without touching their code, data, ports or web server files:
#   - nightly backups of every product (03:30 UTC) and a weekly restore drill (Sundays 04:30 UTC), as systemd timers
#   - memory and CPU ceilings for each service, so one runaway process can't starve the others or the server
#   - a cap on the system log's disk use
#   - Uptime Kuma (status page) and Umami (visitor stats), see monitoring.sh
# Safe to run again: every step replaces what the last run made.
set -euo pipefail
OPS=/opt/novenique/ops BK=/var/backups/novenique

# ---- code ----
sudo rm -rf "$OPS.new" && sudo mkdir -p "$OPS.new" && sudo tar -xzf /tmp/novenique-ops.tgz -C "$OPS.new" && rm -f /tmp/novenique-ops.tgz
sudo rm -rf "$OPS.old"; [ -d "$OPS" ] && sudo mv "$OPS" "$OPS.old"; sudo mv "$OPS.new" "$OPS"; sudo rm -rf "$OPS.old"
sudo chown -R root:root /opt/novenique && sudo chmod -R go-w /opt/novenique
sudo install -d -m 700 -o root -g root "$BK"

# ---- backups and the restore drill ----
job() {  # name, description, command, OnCalendar
  sudo tee "/etc/systemd/system/novenique-$1.service" >/dev/null <<UNIT
[Unit]
Description=$2
After=local-fs.target
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 $OPS/backup/novenique_backup.py $3
Nice=10
IOSchedulingClass=idle
CPUWeight=20
MemoryMax=1G
UNIT
  sudo tee "/etc/systemd/system/novenique-$1.timer" >/dev/null <<UNIT
[Unit]
Description=$2 (schedule)
[Timer]
OnCalendar=$4
Persistent=true
RandomizedDelaySec=300
[Install]
WantedBy=timers.target
UNIT
}
job backup "Novenique nightly backup of every product" "backup --config $OPS/backup/sources.json" "*-*-* 03:30:00 UTC"
job drill "Novenique weekly restore drill (never touches live data)" "drill --root $BK" "Sun *-*-* 04:30:00 UTC"
sudo systemctl daemon-reload
sudo systemctl enable --now novenique-backup.timer novenique-drill.timer >/dev/null

# ---- memory and CPU ceilings ----
# MemoryHigh slows a service down before MemoryMax stops it. A ceiling is never set below twice what the service uses
# right now, so a busy service is never squeezed by this script. CPUWeight shares the cores when they are busy
# (100 is normal); the web server gets more so pages keep loading, background work gets less.
limit() {  # unit, default max in MB, cpu weight
  systemctl cat "$1.service" >/dev/null 2>&1 || return 0
  local cur max high
  cur=$(systemctl show "$1" -p MemoryCurrent --value 2>/dev/null)
  case "$cur" in ''|'[not set]'|infinity) cur=0 ;; *) cur=$((cur / 1048576)) ;; esac
  max=$2; [ $((cur * 2)) -gt "$max" ] && max=$((cur * 2))
  high=$((max * 8 / 10))
  sudo systemctl set-property "$1.service" MemoryHigh="${high}M" MemoryMax="${max}M" CPUWeight="$3"
  printf '%-18s now %5s MB  ceiling %5s MB  cpu weight %s\n' "$1" "$cur" "$max" "$3"
}
limit caddy 512 200
limit palasora-pb 1536 150
limit palasora-api 1536 100
limit palasora-web 1536 100
limit palasora-worker 2048 50
limit agent-grand-prix 512 100
limit jisst-chat 1024 100
limit jisst-gateway 512 100
limit jisst-calls 1024 100

# ---- system log: at most 500 MB on disk ----
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\n' | sudo tee /etc/systemd/journald.conf.d/novenique.conf >/dev/null
sudo systemctl restart systemd-journald

# ---- status page and visitor stats ----
OWNER_PASSWORD=''; if [ -f /tmp/novenique-owner.env ]; then OWNER_PASSWORD=$(sed -n 's/^OWNER_PASSWORD=//p' /tmp/novenique-owner.env); rm -f /tmp/novenique-owner.env; fi
PUBLIC_IP="${PUBLIC_IP:-}" OWNER_PASSWORD="$OWNER_PASSWORD" bash "$OPS/server/monitoring.sh" || echo "::warning::The status page or visitor stats did not finish installing."

systemctl list-timers novenique-* --no-pager | head -5
