# Server safety (Phase 0)

Everything here keeps the shared Oracle server safe for both games. Nothing in it touches a game's code, data, ports
or web server files.

| Piece | What it does | Where |
| --- | --- | --- |
| Nightly backup | 03:30 UTC: every database (SQLite online backup, services keep running), uploaded files, analytics, env files and web server certificates for every product into `/var/backups/novenique/novenique-<time>/`, with a manifest and checksums. Keeps 14. | `backup/novenique_backup.py`, `backup/sources.json` |
| Restore drill | Sundays 04:30 UTC: re-checks the newest backup, opens every database copy in a scratch folder, checks it is intact and its row counts match. Never touches live data. Result in `/var/backups/novenique/LAST_DRILL.json`. | same tool, `drill` |
| Off-server copy | 04:15 UTC: the newest backup, encrypted with your passphrase on GitHub's machine, kept 30 days as a workflow artifact. Fails (and emails you) if the newest backup is over 30 hours old. | `.github/workflows/backup-offsite.yml` |
| Ceilings | Memory and CPU limits per service (never below twice what a service uses at install time); system log capped at 500 MB. | `server/install.sh` |
| Server check | Read-only report: memory, disk, CPU, services, ports, versions, data sizes, backups, timers. Mondays, or on demand. | `check/server-check.sh`, `.github/workflows/server-check.yml` |
| Status page | Uptime Kuma (MIT): checks every site each minute, keeps the history, can alert by email or Telegram. At `https://status.129-146-26-28.sslip.io` behind your `OWNER_PASSWORD` (username `owner`); create its admin account on the first visit. | `server/monitoring.sh` |
| Visitor stats | Umami (MIT): page views without cookies or personal data, for Jisst and the games, with its own Postgres (dumped nightly at 03:20 for the backup). At `https://stats.129-146-26-28.sslip.io`, username `admin`, password your `OWNER_PASSWORD`. | `server/monitoring.sh` |
| Uptime | Every site every 15 minutes; opens an issue here when one is down, closes it when it's back. | `.github/workflows/uptime.yml` |
| Race benchmark | How many real-time races the server can run at once, with the game's own engine. On demand. | `bench/race-bench.mjs`, `.github/workflows/bench.yml` |

## One-time setup

In this repository's **Settings > Secrets and variables > Actions > New repository secret**:

- `SERVER_HOST`, `SERVER_USER`, `SERVER_SSH_KEY`: the same values the games use.
- `BACKUP_PASSPHRASE`: a long sentence only you know. Save it in your password manager too: a restore needs it.
- `OWNER_PASSWORD`: a password of your choice. It opens the status page and is the visitor stats' admin password.

Then open **Actions > Server safety (deploy) > Run workflow** once (later it runs by itself when `ops/` changes).

## Restoring

Backups are restored into an empty folder first, never over live data:

```bash
sudo python3 /opt/novenique/ops/backup/novenique_backup.py status                   # newest backups
sudo python3 /opt/novenique/ops/backup/novenique_backup.py restore /var/backups/novenique/novenique-<time> palasora /tmp/restore
```

Every file sits under its original path inside the set (for example `/tmp/restore/var/lib/palasora/data/economy.db`).
Stop that product's services, move the files into place, start the services.

From the off-server copy (download the artifact from the workflow run, unzip it):

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in novenique-<time>.tar.gz.enc | tar -xzf -
```
