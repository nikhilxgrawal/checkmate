# CHECKMATE — The Acevector Chess Tournament

A tournament website: admin manages players/matches, viewers support players,
and two leaderboards track support received and matches won.

## Run locally

```bash
npm install
ADMIN_KEY=your-secret npm start
# open http://localhost:3000  (admin at /admin.html)
```

## Features
- Public matches page with one-click "Support" voting + live vote bars
- Support leaderboard (total support per player)
- Winners leaderboard (matches won per player)
- Admin panel (key-protected): add/remove players, add/delete matches, set winners

## Deploy to Render (free)

1. Push this folder to a GitHub repo.
2. Go to https://render.com → New → **Web Service** → connect the repo.
3. Render auto-detects `render.yaml`. Confirm:
   - Runtime: Node · Build: `npm install` · Start: `npm start` · Plan: Free
4. Add an environment variable **ADMIN_KEY** = your secret admin key.
5. Deploy. You get a URL like `https://checkmate-acevector.onrender.com`.

Notes:
- Free tier sleeps after ~15 min idle (first request wakes it in ~30-50s).
- Data is stored in `data/db.json` (ephemeral on free tier — resets on redeploy).
  For persistent data, attach a Render Disk or move to a database.
