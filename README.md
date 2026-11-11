# Noveniqe deploy desk

The code that used to live here, Onyx (the shared chassis of Amaete Venture Studios: accounts, payments, backups and
server safety), has its own home now: [amaeteventurestudios/onyx](https://github.com/amaeteventurestudios/onyx).

This repository keeps the workflows that reach the shared Oracle server, because the server key and the other secrets
(Google, email, Stripe, backups) are saved here. Each workflow checks out the code it deploys from that product's own
repository:

| Workflow | Deploys | From |
| --- | --- | --- |
| Accounts service (deploy) | Onyx accounts (`core/`), every 30 minutes when onyx's main changed | amaeteventurestudios/onyx |
| Server safety (deploy) | backups, restore drill, limits, status page (`ops/`), same rule | amaeteventurestudios/onyx |
| Jisste, SavvyMe, ISOTEH, Agent Warfront (deploy) | each app | its own repository |
| Noveniqe website (deploy) | the company website at noveniqe.com, whenever `site/` changes on main | this repository (`site/`) |
| Off-server backup, Server check, Uptime, Bench, Grant, Delete, Join the grid | checks and one-off jobs | amaeteventurestudios/onyx |

"Run workflow" on any of them runs it straight away. To change Onyx itself, open a pull request in the onyx repo.
