# Novenique Core: one account for every game

Core runs the accounts site (accounts.novenique.com, spare address accounts.129-146-26-28.sslip.io). People sign in
there once and play both Agent Grand Prix and Palasora under one user id. Each game keeps its own brand and its own
session cookie. Plain Node 22 with no dependencies.

## What it does
- **Sign-in methods.** Guest, Google, and a 6-digit email code. Google and email are each off until their key is set
  (see `.github/workflows/core-deploy.yml`). There are no passwords.
- **Signing in from a game.** The game uses the "authorization code with PKCE" flow (`lib/app.mjs` explains each step).
  The game's server swaps the one-time code at `POST /token` for the player's id, name, @handle, roles, and any guest
  ids that were merged into the account.
- **Guests.** The game's server calls `POST /v1/guests` and gets a user id and a guest token. Later, `POST /v1/link-intents`
  followed by `/authorize?...&link=` saves the guest's progress.
  - A new email or Google account is added to the same user id.
  - An email or Google account that already has an account merges the guest into it. This only happens after the
    player says yes. The game learns of the merge from `merged_from` and `GET /v1/merges`.
- **Signing in on the game's own screen.** A game can keep sign-in on its own page, so players never see Novenique.
  - Email: the game's server calls `POST /v1/signin/email/start {email, ip}` and then `/v1/signin/email/verify {email, code, guest_token?}`.
  - Google: the game sends the player to `/authorize?...&via=google`, which goes straight to Google. With `google_redirect` set in
    `deploy/clients.json`, Google returns to the game's own address, and the game forwards the request to `/google/callback` unchanged.
  - Every answer carries a `ticket` (signed, 30 minutes, that game only). `needs_profile` means the game asks for a name and
    @handle, then calls `/v1/signin/profile {ticket, display_name, handle}`.
  - `merge_needed` (or `merge` and `who` on the Google return) means the game asks before a guest's progress moves into an
    existing account, then calls `/v1/signin/merge {ticket, choice: 'merge'}`.
- **Names.** Each person has a name and an @handle. Handles are unique across Novenique. Brand names and staff words are
  reserved, including look-alikes. A handle can change once every 30 days, and the old one is held for its owner for
  30 days.
- **Roles.** Roles are scoped by product: `platform` (all of Novenique), `agp` and `palasora`. They are listed in
  `lib/roles.mjs`, which holds the matrix, the escalation guard and the route table.
  - Staff need the second sign-in step (an authenticator app).
  - Money, secrets and exporting the audit trail are for the Super Administrator only.
  - Games ask `GET /v1/authz`, and can only ask about their own product.
- **Accounts page.** Shows sign-in methods and sessions, with sign out there, sign out everywhere, and asking to delete
  the account.
- **The pass (payments).** One Stripe account sells every game's pass (`lib/billing.mjs`). A game's plans sit with the game in
  `deploy/clients.json` (`pass.plans`: price in US cents, on or off, the Stripe Price ID), so a new game sells a pass by adding
  lines there. Game servers ask `GET /v1/pass?user_id=`, `GET /v1/passes`, and send players to `POST /v1/pass/checkout` and
  `POST /v1/pass/manage` (Stripe's billing page). Stripe's signed webhooks (`POST /stripe/webhook`, or a game's own webhook
  passed on unchanged) grant, renew and end a pass. `POST /v1/pass/import` brings in passes a game sold before Core did.
  The Stripe keys come from the noveniqe secrets `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, or else from Agent Grand
  Prix's settings on the server.
- **Staff admin API.** `/admin/api/*`: users, granting roles, and the audit trail.

## Where data lives
Core keeps its data in the shared store, Palasora's PocketBase.
- A person is one row in Palasora's `users` table, the same row Palasora reads. Palasora's own sign-up accounts keep
  their id when they sign in through Novenique.
- Core's own tables all start with `nv_` and are created on start-up (`lib/schema.mjs`). Core never changes the shape
  of Palasora's tables.
- Every action is written to Palasora's `audit_events`, tagged `source: novenique-core`.

PocketBase normally writes a migration file whenever a table is created through its API. On the server it cannot (Palasora's
code folder is read-only to the database), so nothing is written. For a local Palasora, start PocketBase with
`--automigrate=false` before running Core against it.

## Run and test
```
PB_BIN=/path/to/pocketbase-0.40.5 npm test --prefix core                  # 21 tests against a throwaway PocketBase
PB_MIGRATIONS=../palasora/services/pocketbase/pb_migrations PB_BIN=... npm test --prefix core   # against Palasora's real schema
```

## On the server
- `deploy/install.sh` runs on every merge that touches `core/`. It installs:
  - service `novenique-core` on 127.0.0.1:8200;
  - settings and secrets in `/etc/novenique` (made once on the server);
  - one secret per game in `/etc/novenique/clients/`, with Palasora's copy in `/etc/palasora-novenique.env`;
  - Core's own database account;
  - the Caddy site file.
- `accounts.novenique.com` is added automatically on the first deploy after its DNS record points at the server.
- The first Super Administrator is set with the **Grant a role** workflow (Actions tab), after they have signed in once.
