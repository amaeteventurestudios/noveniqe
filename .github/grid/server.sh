#!/usr/bin/env bash
# Runs on the shared server as root, from the "Join USG Grid" workflow. ACTION, PUBKEY and TS_AUTHKEY come from it.
set -euo pipefail
HOSTNAME_TS=noveniqe-prod
# ai-node-01's tailnet addresses: the only source the install key is accepted from.
AI_NODE_FROM='100.127.44.118,fd7a:115c:a1e0::8a2f:2c77'
KEYS=/home/ubuntu/.ssh/authorized_keys
MARK='usg-grid-install'

status() {
  echo '### Tailscale'
  if command -v tailscale >/dev/null; then
    echo '```'; tailscale status --self --peers=false 2>&1 | head -5 || true; echo '```'
    echo "Tailnet IPv4: \`$(tailscale ip -4 2>/dev/null || echo none)\`  "
    echo "Tailnet IPv6: \`$(tailscale ip -6 2>/dev/null || echo none)\`  "
    echo "DNS name: \`$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || echo unknown)\`"
  else
    echo 'Not installed.'
  fi
  echo; echo '### Install key'
  grep -q "$MARK" "$KEYS" 2>/dev/null && echo 'ai-node-01 install key: **present** (revoke it once Grid telemetry is in)' || echo 'ai-node-01 install key: absent'
  echo; echo '### Host'
  echo "Hostname \`$(hostname)\`, $(. /etc/os-release; echo "$PRETTY_NAME"), $(uname -m)  "
  echo "SSH host key: \`$(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}')\`"
  id usg-grid-ro >/dev/null 2>&1 && echo "Grid telemetry account: present" || echo "Grid telemetry account: absent"
}

case "${ACTION:-status}" in
  join)
    if ! command -v tailscale >/dev/null; then
      curl -fsSL https://tailscale.com/install.sh | sh >/dev/null
    fi
    systemctl enable --now tailscaled >/dev/null
    if tailscale status >/dev/null 2>&1; then
      echo 'Already on the tailnet; nothing to join.'
    else
      # --ssh is off on purpose: Grid reaches the node with plain OpenSSH under a forced-command key.
      tailscale up --authkey="$TS_AUTHKEY" --hostname="$HOSTNAME_TS" --accept-dns=false --ssh=false
      echo 'Joined the tailnet.'
    fi
    echo; status ;;
  allow-install-key)
    install -d -o ubuntu -g ubuntu -m 700 /home/ubuntu/.ssh
    touch "$KEYS"; chown ubuntu:ubuntu "$KEYS"; chmod 600 "$KEYS"
    sed -i "/$MARK/d" "$KEYS"
    printf 'from="%s" %s %s\n' "$AI_NODE_FROM" "$PUBKEY" "$MARK" >> "$KEYS"
    echo 'Install key added for ubuntu, accepted from ai-node-01 over Tailscale only.'; echo; status ;;
  revoke-install-key)
    sed -i "/$MARK/d" "$KEYS" 2>/dev/null || true
    echo 'Install key removed.'; echo; status ;;
  status) status ;;
  *) echo "unknown action $ACTION" >&2; exit 2 ;;
esac
