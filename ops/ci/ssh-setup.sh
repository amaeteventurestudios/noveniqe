#!/usr/bin/env bash
# Used by the workflows: turns the SERVER_* secrets into a key file and an ssh command, forgiving extra words pasted
# into the secrets (the same rules as the games' deploys). Writes SSH="ssh ..." and SCP="scp ..." to $GITHUB_ENV.
set -euo pipefail
if [ -z "${HOST:-}" ] || [ -z "${KEY:-}" ]; then
  echo '::error::Add the SERVER_HOST, SERVER_USER and SERVER_SSH_KEY secrets to this repository first (same values as the games use).'; exit 1
fi
HOST=$(printf '%s' "$HOST" | grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}|[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+' | tail -1)
USER=$(printf '%s' "${USER:-}" | grep -oE '[a-z_][a-z0-9_-]*' | tail -1 || true); USER="${USER:-ubuntu}"
K="$RUNNER_TEMP/server_key"
install -m 600 /dev/null "$K" && printf '%s\n' "$KEY" | tr -d '\r' | sed -n '/-----BEGIN/,/-----END/p' > "$K"
[ -s "$K" ] || { echo '::error::SERVER_SSH_KEY should hold the whole key file, from the -----BEGIN line to the -----END line.'; exit 1; }
OPTS="-i $K -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o ServerAliveInterval=30"
{ echo "SSH=ssh $OPTS $USER@$HOST"; echo "SCP=scp $OPTS"; echo "DEST=$USER@$HOST"; } >> "$GITHUB_ENV"
