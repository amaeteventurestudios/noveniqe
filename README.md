# Onyx, the Noveniqe platform

**Onyx** is the foundation every Noveniqe product plugs into: Agent Grand Prix, Palasora, Jisste (the messenger and
social network) and every game and app that comes next. ISOTEH, the ad network, plugs in the same way, as one more
client, so it can also serve outside sites. Onyx is an internal name (no domain of its own). The products keep their
own repositories and brands; this one holds what they share: accounts and sign-in, payments and the pass, agents,
backups, uptime and server safety.

In code and on the server the older names stay as they are (`core/`, the `novenique-core` service, `NOVENIQUE_*`
settings): renaming them would change nothing for people and risk breaking sign-in.

- `ops/`: server safety for the shared Oracle server (backups, restore drills, resource ceilings, checks, uptime,
  race capacity benchmark). See [ops/README.md](ops/README.md).
- `core/`: Onyx accounts (called Novenique Core in code), one account for every game (guest, Google, email codes, sign-in across the games' domains,
  roles per game). See [core/README.md](core/README.md).
