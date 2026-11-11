#!/usr/bin/env bash
# Puts the Noveniqe website (this repo's site/ folder, uploaded as /tmp/noveniqe-site.tgz) on the shared Oracle server:
# files in /var/www/noveniqe-site, served by the shared Caddy from its own site file.
# Run by the workflow "Noveniqe website (deploy)" with SITE_NAMES (the main name first, e.g. "noveniqe.com www.noveniqe.com";
# only names whose DNS already points here) and SPARE (a free sslip.io name for the server).
# Never touches /etc/caddy/Caddyfile or another project's site file.
set -euo pipefail
WEB=/var/www/noveniqe-site FILE=/etc/caddy/sites/noveniqe-site.caddy
if [ ! -x /usr/local/bin/caddy ] || [ ! -d /etc/caddy/sites ]; then
  echo 'The shared Caddy web server is missing (the Agent Grand Prix deploy installs it).'; exit 1
fi
# swap the whole folder in one move so visitors never see half a deploy
sudo rm -rf "$WEB.new" && sudo mkdir -p "$WEB.new"
sudo tar -xzf /tmp/noveniqe-site.tgz -C "$WEB.new"; rm -f /tmp/noveniqe-site.tgz
sudo chmod -R a+rX "$WEB.new"
sudo rm -rf "$WEB.old"; [ -d "$WEB" ] && sudo mv "$WEB" "$WEB.old"; sudo mv "$WEB.new" "$WEB"; sudo rm -rf "$WEB.old"

read -r -a NAMES <<<"${SITE_NAMES:-}"
MAIN=${NAMES[0]:-$SPARE}
SERVE="$MAIN"; [ "$MAIN" != "$SPARE" ] && SERVE="$MAIN, $SPARE"
OTHERS=""
for n in "${NAMES[@]:1}"; do OTHERS="$OTHERS${OTHERS:+, }$n"; done
BLOCK='encode zstd gzip
	root * '"$WEB"'
	header /index.html Cache-Control "no-cache"
	header / Cache-Control "no-cache"
	header /a/* Cache-Control "public, max-age=604800"
	header X-Content-Type-Options nosniff
	header Referrer-Policy strict-origin-when-cross-origin
	try_files {path} {path}.html /index.html
	file_server'
{
  printf '%s {\n\t%s\n}\n' "$SERVE" "$BLOCK"
  [ -n "$OTHERS" ] && printf '%s {\n\tredir https://%s{uri} permanent\n}\n' "$OTHERS" "$MAIN"
} | sudo tee "$FILE" >/dev/null
if ! sudo /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>/tmp/nv-site-caddy.err; then
  sudo rm -f "$FILE"; cat /tmp/nv-site-caddy.err | tail -5
  echo 'The Noveniqe website site file did not validate, so it was taken out again. The other sites are untouched.'; exit 1
fi
sudo systemctl reload caddy
echo "Noveniqe website installed for: $SERVE${OTHERS:+ (and $OTHERS sends visitors there)}"
