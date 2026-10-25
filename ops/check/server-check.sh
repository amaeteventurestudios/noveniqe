#!/usr/bin/env bash
# Read-only report on the shared server: what it is, what runs on it, how full it is, how old the backups are.
# Sent over SSH by .github/workflows/server-check.yml; prints Markdown for the job summary. Changes nothing.
set -uo pipefail
row() { printf '| %s | %s |\n' "$1" "$2"; }
have() { command -v "$1" >/dev/null 2>&1; }
ver() { "$@" 2>/dev/null | head -1 | tr '|' '/' ; }

echo "## Server check: $(hostname) at $(date -u '+%Y-%m-%d %H:%M UTC')"
echo
echo '### Machine'
echo '| Measure | Value |'
echo '| --- | --- |'
row 'System' "$(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}") · $(uname -m) · kernel $(uname -r)"
row 'CPU' "$(nproc) cores · $(grep -m1 -E 'model name|CPU part' /proc/cpuinfo | cut -d: -f2 | xargs)"
row 'Load (1, 5, 15 min)' "$(cut -d' ' -f1-3 /proc/loadavg)"
row 'Up since' "$(uptime -s 2>/dev/null)"
read -r _ total used free shared cache avail < <(free -m | awk '/^Mem:/ {print $1,$2,$3,$4,$5,$6,$7}')
row 'Memory (MB)' "total ${total} · used ${used} · available ${avail}"
row 'Swap (MB)' "$(free -m | awk '/^Swap:/ {print "total " $2 " · used " $3}')"
row 'Disk /' "$(df -h / | awk 'NR==2 {print $3 " used of " $2 " (" $5 "), " $4 " free"}')"
echo
echo '### Services (memory from systemd)'
echo '| Service | State | Memory | Since |'
echo '| --- | --- | --- | --- |'
for s in caddy palasora-pb palasora-api palasora-worker palasora-web agent-grand-prix spacetimedb ollama docker; do
  st=$(systemctl is-active "$s" 2>/dev/null); [ -z "$st" ] && st=unknown
  [ "$st" = inactive ] && ! systemctl cat "$s" >/dev/null 2>&1 && continue
  mem=$(systemctl show "$s" -p MemoryCurrent --value 2>/dev/null); case "$mem" in ''|'[not set]'|infinity) mem='-' ;; *) mem="$((mem / 1048576)) MB" ;; esac
  max=$(systemctl show "$s" -p MemoryMax --value 2>/dev/null); case "$max" in ''|infinity) ;; *) mem="$mem (max $((max / 1048576)) MB)" ;; esac
  since=$(systemctl show "$s" -p ActiveEnterTimestamp --value 2>/dev/null)
  printf '| %s | %s | %s | %s |\n' "$s" "$st" "$mem" "${since:--}"
done
echo
echo '### Top processes by memory'
echo '```'
ps -eo rss=,pcpu=,user=,comm= --sort=-rss | head -12 | awk '{printf "%7.0f MB  %5s%% cpu  %-12s %s\n", $1/1024, $2, $3, $4}'
echo '```'
echo
echo '### Software'
echo '| Program | Version |'
echo '| --- | --- |'
row 'Caddy' "$(ver /usr/local/bin/caddy version || echo 'not found')"
row 'PocketBase (Palasora)' "$(ver /usr/local/bin/palasora-pocketbase --version || echo 'not found')"
row 'Node (Palasora)' "$(ver /opt/palasora-node/bin/node --version || echo 'not found')"
row 'Node (Agent Grand Prix)' "$(ver /opt/agp-node/bin/node --version || echo 'not found')"
row 'Python' "$(ver python3 --version)"
row 'SpacetimeDB' "$( (have spacetime && ver spacetime --version) || (ls -d /opt/spacetime* /root/.local/bin/spacetime 2>/dev/null | head -1) || echo 'not installed')"
row 'Ollama' "$( (have ollama && ver ollama --version) || echo 'not installed')"
row 'Docker' "$( (have docker && ver docker --version) || echo 'not installed')"
echo
echo '### Listening ports (anything not on 127.0.0.1 is reachable from outside if the firewall allows it)'
echo '```'
sudo -n ss -ltnpH 2>/dev/null | awk '{print $4, $6}' | sed 's/users:((//; s/,pid=.*//' | sort -u || ss -ltnH | awk '{print $4}'
echo '```'
echo
echo '### Data folders'
echo '| Folder | Size |'
echo '| --- | --- |'
for d in /var/lib/palasora /var/lib/private/agp /var/lib/agent-grand-prix /var/lib/private/caddy /var/www /opt /var/backups/novenique /var/log/journal; do
  [ -e "$d" ] && row "$d" "$(sudo -n du -sh "$d" 2>/dev/null | cut -f1)"
done
echo
echo '### Backups'
if [ -x /opt/novenique/ops/backup/novenique_backup.py ] || [ -f /opt/novenique/ops/backup/novenique_backup.py ]; then
  echo '```'
  sudo -n python3 /opt/novenique/ops/backup/novenique_backup.py status 2>&1 | head -60
  echo '```'
else
  echo 'Novenique backups are not installed yet.'
fi
echo
echo '### Timers and scheduled jobs'
echo '```'
systemctl list-timers --all --no-pager 2>/dev/null | grep -Ev '^$|timers listed' | head -20
for u in root ubuntu; do sudo -n crontab -l -u "$u" 2>/dev/null | grep -v '^#' | sed "s/^/cron($u): /"; done
echo '```'
