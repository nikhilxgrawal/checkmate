# SnapGames — The Acevector Gaming Arena

An internal, multi-org tournament and prediction platform. Employees verify a
work email, build a profile, register for tournaments, play matches, and place
pari-mutuel points predictions on live matches. Admins run everything from a
key-protected control panel.

> The project was originally "CHECKMATE" (a single chess tournament). It has
> since grown into a general, multi-game, multi-org platform.

## Features

- **Email OTP login** — passwordless. A 6-digit code is emailed; sessions are
  stateless signed tokens (HMAC), valid 12h.
- **Allowed orgs (admin-managed)** — only configured email domains can join.
  Each domain's first label is the "org" (`g.siva@unicommerce.com` → **G Siva**,
  org **Unicommerce**). Add/remove orgs live from the admin panel.
- **User profiles** — name and org derived from the email; shows tournaments
  participated, games played, games won, podiums, per-tournament position, and
  (on your own profile) your wallet balance. Browse everyone on the Profiles
  page and open any profile from leaderboards, chat-free listings, or the nav.
- **Tournaments** — admin-created, with a registration window and an org scope
  (all orgs, or a chosen subset). Users register/unregister while the window is
  open and only if their org is eligible.
- **Matches under a tournament** — a match is created between two users who are
  **registered to that tournament**. Match results feed each player's profile
  and the leaderboards.
- **Pari-mutuel predictions** — each verified user gets a points wallet. Bets go
  into a shared per-match pool; when the result is set, winners split the whole
  pool proportional to stake.
- **Admin wallet top-ups** — admins can add points to any user's wallet (or
  deduct with a negative amount; balance can't go below zero) from the panel.
- **Leaderboards** — match winners, top bidders (net winnings), and most-backed
  players. Names link to profiles.
- **Community** — pre-moderated posts (admin approves) and per-game live chat.
- **Realtime** — Server-Sent Events push live updates (matches, results, bets,
  chat, moderation, tournaments).
- **Bulk upload** — import matches from an `.xlsx` (see below).
- **Admin panel** — manage allowed orgs, tournaments (+ results), matches,
  community moderation, and bulk upload.

## Tech stack

- Node.js (>=18) + Express
- MySQL via `mysql2`
- `nodemailer` (OTP + notification emails)
- `multer` + `xlsx` (bulk upload)
- Vanilla HTML/CSS/JS frontend in `public/` (no build step)

## Run locally

Prerequisites: Node 18+ and a running MySQL (local or hosted).

```bash
# 1. install deps
npm install

# 2. create the database + tables
mysql -u root < schema.sql        # creates the `checkmate` schema

# 3. configure env
cp .env.example .env              # then edit values (see below)

# 4. start
npm start
# open http://localhost:3000   (admin at /admin.html)
```

The server also creates any missing config tables (`allowed_domains`,
`app_meta`) on boot, so an existing database is upgraded automatically.

### Local login without SMTP

Set `OTP_DEV_ECHO=true` in `.env`. The 6-digit code is then printed to the
**server console** instead of being emailed, so you can log in without an SMTP
setup. Never enable this in production — it exposes codes.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (default 3000). |
| `ADMIN_KEY` | **Required.** Key for the admin panel / `x-admin-key` header. The server refuses to start without it. |
| `STARTING_BALANCE` | Points each user starts with (default 10000). |
| `MAX_BID` | Max points per bid; `0`/unset = no cap (up to balance). |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | MySQL connection. |
| `DB_SSL` | `true` to require TLS (managed hosts like TiDB Cloud / Aiven). |
| `DB_CA` | PEM cert for a private CA (only if the host needs one). |
| `SESSION_SECRET` | HMAC secret for session tokens. Set a long, **stable** value in prod (`openssl rand -hex 32`) or logins reset on every restart. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` | Outbound email for OTP + notifications. |
| `MAIL_FROM` | Verified sender address for emails. |
| `ALLOWED_EMAIL_DOMAINS` | Comma-separated domains used to **seed** the allowed-org list on first boot. After that, manage it from the admin panel. Blank = any domain. |
| `OTP_DEV_ECHO` | Dev only: `true` prints OTP codes to the console and skips email. |
| `PUBLIC_URL` | Public base URL (used in email links and the keep-alive self-ping). |

> Allowed orgs are stored in the database and managed from the admin panel.
> `ALLOWED_EMAIL_DOMAINS` only seeds the list the first time (or on a fresh DB);
> editing it later won't override what you set in the panel.

## Admin panel

Open `/admin.html` and enter `ADMIN_KEY`. Sections:

- **Allowed Orgs** — add/remove email domains; the org name is derived from the
  domain. Removing all domains opens the platform to any email. Removing an org
  blocks new registrations from it but keeps existing users.
- **Manage Tournaments** — create tournaments (name, game name, registration
  window, org scope). Edit is collapsible per row; "Results" records each
  participant's games won and final position.
- **Add Match** — pick a tournament, then two of its **registered** users, and
  a start/end time (auto go-live / auto-over).
- **Add Cash** — credit (or deduct) points for any user; shows every user's
  current balance.
- **Bulk Upload** — import matches from `.xlsx`.
- **Community Moderation** — approve/reject pending posts.

### Bulk upload format

Download the template from the admin panel (or `GET /api/admin/matches/template`)
and edit it. One match per row; players are given by **email**:

| column | required | notes |
| --- | --- | --- |
| `tournament` | yes | Tournament name. Auto-created (open to all orgs, no window) if new. |
| `gameType` | no | Game label; only used when the tournament is auto-created. |
| `playerA_email` | yes | Must be a valid email. |
| `playerB_email` | yes | Must differ from player A. |
| `location` | no | Display location. |
| `startAt` | no | `YYYY-MM-DD HH:MM` (auto go-live). |
| `endAt` | no | `YYYY-MM-DD HH:MM` (auto-over). |

For each row the importer, in order: **ensures the users exist** — an email that
already has a profile is reused as-is (no duplicate), a new email is created
pre-verified (no OTP needed; name/org derived from the email) — then
**registers both to the tournament** and **creates the match**. `startAt` and
`endAt` are both optional. Valid rows are applied and invalid rows are skipped
with a per-row reason. Org-restricted tournaments still reject users whose org
isn't allowed.

## Data model (MySQL)

`users`, `wallets`, `tournaments`, `tournament_registrations`, `games`,
`players` (match roster, linked to a user by email), `matches`, `bids`, `posts`,
`chat`, `notify_optins`, `allowed_domains`, `app_meta`. See `schema.sql`.

## Database setup & migrations

- **Fresh database:** run `schema.sql` once (`mysql -u <user> -p < schema.sql`).
  It contains every table with all current columns.
- **Existing database** (created before profiles/tournaments/orgs): run the
  idempotent `migrations.sql` (`mysql -u <user> -p <db> < migrations.sql`). It
  adds the new tables (`users`, `tournaments`, `tournament_registrations`,
  `allowed_domains`, `app_meta`) and the new columns (`players.email`,
  `matches.tournamentId`, `tournaments.orgs`). Safe to re-run.
- **Automatic:** on startup the app runs the same migration in code
  (`ensureSchema()`), so if the app's DB user has `CREATE`/`ALTER` privileges
  the schema is brought up to date on deploy with no manual step. Use
  `migrations.sql` only when the app user can't run DDL.

## Deploy (Render)

1. Push to a GitHub repo and create a **Web Service** (Render auto-detects
   `render.yaml`: Node · `npm install` · `npm start`).
2. Provision a MySQL database (Render add-on or an external host such as TiDB
   Cloud / Aiven). Set `DB_*` and `DB_SSL=true` if the host requires TLS.
3. Initialize the schema: a fresh DB needs `schema.sql` once; an existing DB
   needs `migrations.sql`. (The app also auto-migrates on boot if its DB user
   can run DDL — see "Database setup & migrations".)
4. Set env vars: `ADMIN_KEY`, `SESSION_SECRET`, the `DB_*` values, `SMTP_*` +
   `MAIL_FROM`, `PUBLIC_URL`, and (optionally) `ALLOWED_EMAIL_DOMAINS` to seed
   the first org list. Do **not** set `OTP_DEV_ECHO` in production.
5. Deploy. `PUBLIC_URL` enables a keep-alive self-ping so the free tier doesn't
   idle out (pair with an external uptime pinger for full reliability).
