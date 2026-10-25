# Novenique

Shared platform for the Novenique games (Agent Grand Prix, Palasora). The games keep their own repositories; this one
holds what they share.

- `ops/`: server safety for the shared Oracle server (backups, restore drills, resource ceilings, checks, uptime,
  race capacity benchmark). See [ops/README.md](ops/README.md).
- `core/`: Novenique Core, one account for every game (guest, Google, email codes, sign-in across the games' domains,
  roles per game). See [core/README.md](core/README.md).
