require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const auth = require("./auth");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "acevector2026";
const DATA_FILE = path.join(__dirname, "data", "db.json");

// Parse JSON bodies. Use type:"*/*" so requests still parse even if a client
// sends the wrong (or missing) Content-Type header — avoids "body not parsed"
// bugs from cached/older frontend code.
app.use(express.json({ type: () => true, limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- Data layer (JSON file store) ----------
function loadDB() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const db = JSON.parse(raw);
    // ensure new collections exist for backward compatibility
    db.games = db.games || [];
    db.players = db.players || [];
    db.matches = db.matches || [];
    db.predictions = db.predictions || db.votes || []; // legacy (kept, unused by betting)
    db.bets = db.bets || [];       // { id, matchId, email, outcome, stake, ts, settled, payout }
    db.wallets = db.wallets || {}; // email -> balance (points)
    db.posts = db.posts || [];
    db.chat = db.chat || [];
    db.notifyOptIns = db.notifyOptIns || [];
    delete db.votes;

    // ---- Migration: if there are matches but no games, create a default
    // "Chess" game and assign all existing matches + chat to it. ----
    if (db.games.length === 0 && db.matches.length > 0) {
      const chess = {
        id: id(),
        name: "Chess",
        emoji: "\u265F\uFE0F",
        description: "The Acevector Chess Tournament",
        ts: Date.now(),
      };
      db.games.push(chess);
      db.matches.forEach((m) => { if (!m.gameId) m.gameId = chess.id; });
      db.chat.forEach((c) => { if (!c.gameId) c.gameId = chess.id; });
      saveDB(db);
    }
    return db;
  } catch (e) {
    return {
      games: [], players: [], matches: [], predictions: [], bets: [],
      wallets: {}, posts: [], chat: [], notifyOptIns: [],
    };
  }
}

function saveDB(db) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function id() {
  return crypto.randomBytes(8).toString("hex");
}

// Seed with the tournament invite data if empty
function seedIfEmpty() {
  const db = loadDB();
  if (db.games.length === 0 && db.matches.length === 0) {
    const chess = {
      id: id(),
      name: "Chess",
      emoji: "\u265F\uFE0F",
      description: "The Acevector Chess Tournament",
      ts: Date.now(),
    };
    const players = [
      { id: id(), name: "Sandeep Singh Sachdeva", org: "Snapdeal" },
      { id: id(), name: "Rishi Sharma", org: "Unicommerce" },
      { id: id(), name: "Anshuman Sengar", org: "Unicommerce" },
      { id: id(), name: "Sarthak", org: "Snapdeal" },
    ];
    const matches = [
      {
        id: id(),
        gameId: chess.id,
        playerAId: players[0].id,
        playerBId: players[1].id,
        time: "1:30 PM - 2:00 PM",
        day: "Today",
        location: "Sky Deck - Tower A",
        status: "upcoming",
        result: null,
        winnerId: null,
      },
      {
        id: id(),
        gameId: chess.id,
        playerAId: players[2].id,
        playerBId: players[3].id,
        time: "4:30 PM - 5:00 PM",
        day: "Today",
        location: "Sky Deck - Tower A",
        status: "upcoming",
        result: null,
        winnerId: null,
      },
    ];
    saveDB({
      games: [chess], players, matches,
      predictions: [], bets: [], wallets: {},
      posts: [], chat: [], notifyOptIns: [],
    });
  }
}
seedIfEmpty();

// ---------- Realtime (Server-Sent Events) ----------
const sseClients = new Set();

app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  sseClients.add(res);

  // keep-alive ping
  const ping = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { /* ignore */ }
  }, 25000);

  req.on("close", () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

function broadcast(event, data = {}) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

// ---------- Helpers ----------
function requireAdmin(req, res, next) {
  const key = req.header("x-admin-key");
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized. Invalid admin key." });
  }
  next();
}

function playerMap(db) {
  const m = {};
  db.players.forEach((p) => (m[p.id] = p));
  return m;
}

// ---- Wallet / betting helpers ----
const START_BALANCE = 100;
const MAX_STAKE = 20;

// Get a user's balance, initializing to START_BALANCE on first access.
function getBalance(db, email) {
  if (db.wallets[email] === undefined) db.wallets[email] = START_BALANCE;
  return db.wallets[email];
}

// Compute the pari-mutuel pool for a match: total staked per outcome,
// live decimal odds (totalPool / outcomePool), and grand total.
function matchPool(db, matchId) {
  const bets = db.bets.filter((b) => b.matchId === matchId);
  const pools = { A: 0, B: 0, draw: 0 };
  bets.forEach((b) => { pools[b.outcome] = (pools[b.outcome] || 0) + b.stake; });
  const total = pools.A + pools.B + pools.draw;
  // Decimal odds: payout multiple on a winning stake if that outcome wins and
  // the whole pool is split proportionally. odds = total / outcomePool.
  const odds = {
    A: pools.A > 0 ? +(total / pools.A).toFixed(2) : null,
    B: pools.B > 0 ? +(total / pools.B).toFixed(2) : null,
    draw: pools.draw > 0 ? +(total / pools.draw).toFixed(2) : null,
  };
  return { pools, total, odds, count: bets.length };
}

// The outcome key ("A" | "B" | "draw") that actually won, from a match result.
function winningOutcome(match) {
  const r = matchResult(match);
  if (!r) return null;
  if (r === "draw") return "draw";
  if (r === match.playerAId) return "A";
  if (r === match.playerBId) return "B";
  return null;
}

// Pari-mutuel settlement. Winners split the ENTIRE pool proportional to stake;
// losers forfeit. Credits payouts to wallets. Idempotent-safe when combined
// with unsettleMatch (call unsettle before re-settling on result change).
// Edge cases:
//  - No winning-side bets: pool is forfeited (no one to pay); returns {noWinners:true}.
//  - Only winners, no losers: each winner simply gets their own stake back.
function settleMatch(db, match) {
  const outcome = winningOutcome(match);
  if (!outcome) return { settled: false };
  const bets = db.bets.filter((b) => b.matchId === match.id);
  const total = bets.reduce((s, b) => s + b.stake, 0);
  const winners = bets.filter((b) => b.outcome === outcome);
  const winnerStake = winners.reduce((s, b) => s + b.stake, 0);

  let paid = 0;
  if (winnerStake > 0) {
    // Distribute proportionally; use floor and give remainder to the largest winner.
    let remaining = total;
    winners
      .sort((a, b) => b.stake - a.stake)
      .forEach((b, i) => {
        let share;
        if (i === winners.length - 1) {
          share = remaining; // last winner absorbs rounding remainder
        } else {
          share = Math.floor((b.stake / winnerStake) * total);
          remaining -= share;
        }
        db.wallets[b.email] = (db.wallets[b.email] || 0) + share;
        b.payout = share;
        b.settled = true;
        paid += share;
      });
  }
  // Losers (and, if no winners, everyone) are already settled with payout 0.
  bets.forEach((b) => { b.settled = true; if (b.outcome !== outcome) b.payout = 0; });
  return { settled: true, outcome, total, winnerStake, paid, noWinners: winnerStake === 0 };
}

// Reverse a settlement: reclaim credited payouts back out of wallets and mark
// bets unsettled. Used when an admin changes or clears a result.
function unsettleMatch(db, match) {
  const bets = db.bets.filter((b) => b.matchId === match.id && b.settled);
  bets.forEach((b) => {
    if (b.payout) db.wallets[b.email] = (db.wallets[b.email] || 0) - b.payout;
    b.payout = 0;
    b.settled = false;
  });
}

// ---- Notification opt-in helpers (server-side list keyed by verified email) ----
function isOptedIn(db, email) {
  return db.notifyOptIns.includes(email);
}
// Add an email to the opt-in list (idempotent). Returns true if it was added.
function addOptIn(db, email) {
  if (!email || db.notifyOptIns.includes(email)) return false;
  db.notifyOptIns.push(email);
  return true;
}
function removeOptIn(db, email) {
  const before = db.notifyOptIns.length;
  db.notifyOptIns = db.notifyOptIns.filter((e) => e !== email);
  return db.notifyOptIns.length !== before;
}

// Email all opted-in users that a match just went live. Fire-and-forget with a
// small concurrency limit to respect SES send rate. Never blocks the response.
async function notifyMatchLive(db, match, baseUrl) {
  const pm = playerMap(db);
  const a = pm[match.playerAId] ? pm[match.playerAId].name : "Player A";
  const b = pm[match.playerBId] ? pm[match.playerBId].name : "Player B";
  const line = `${a} vs ${b}`;
  const url = (baseUrl || process.env.PUBLIC_URL || "").replace(/\/$/, "") || undefined;
  const recipients = [...db.notifyOptIns];
  if (recipients.length === 0) return { sent: 0 };

  const CONCURRENCY = 3;
  let i = 0, sent = 0, failed = 0;
  async function worker() {
    while (i < recipients.length) {
      const to = recipients[i++];
      const r = await auth.sendMatchLiveEmail(to, { title: line, line, url });
      if (r.ok) sent++; else failed++;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`[notify] match ${match.id} live: emailed ${sent}/${recipients.length} (failed ${failed})`);
  return { sent, failed, total: recipients.length };
}

// display name from email: "nikhil.agrawal@snapdeal.com" -> "Nikhil Agrawal"
function nameFromEmail(email) {
  const local = String(email || "").split("@")[0];
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") || email;
}

// ---------- Public API ----------

app.get("/api/players", (req, res) => {
  res.json(loadDB().players);
});

// ---- Games ----
function gameSummary(db, g) {
  const gameMatches = db.matches.filter((m) => m.gameId === g.id);
  const live = gameMatches.filter((m) => effectiveStatus(m) === "live").length;
  const upcoming = gameMatches.filter((m) => effectiveStatus(m) === "upcoming").length;
  const completed = gameMatches.filter(
    (m) => effectiveStatus(m) === "finished" || effectiveStatus(m) === "over"
  ).length;
  return {
    ...g,
    matchCount: gameMatches.length,
    liveCount: live,
    upcomingCount: upcoming,
    completedCount: completed,
  };
}

// List all games with counts (for the home page grid + live-now strip).
app.get("/api/games", (req, res) => {
  const db = loadDB();
  const games = db.games
    .map((g) => gameSummary(db, g))
    .sort((a, b) => b.liveCount - a.liveCount || (a.ts || 0) - (b.ts || 0));
  res.json(games);
});

// Single game details.
app.get("/api/games/:gameId", (req, res) => {
  const db = loadDB();
  const g = db.games.find((x) => x.id === req.params.gameId);
  if (!g) return res.status(404).json({ error: "Game not found." });
  res.json(gameSummary(db, g));
});

// Platform-wide stats for the home page bar.
app.get("/api/stats", (req, res) => {
  const db = loadDB();
  const liveMatches = db.matches.filter((m) => effectiveStatus(m) === "live").length;
  const pointsWagered = db.bets.reduce((s, b) => s + b.stake, 0);
  res.json({
    games: db.games.length,
    matches: db.matches.length,
    liveMatches,
    bets: db.bets.length,
    pointsWagered,
    players: db.players.length,
  });
});

// A match is "decided" when the admin has set a result: a player win or a draw.
// We keep legacy winnerId in sync (winnerId = playerId on a player win, null otherwise).
function matchResult(match) {
  // returns "draw" | playerId | null
  if (match.result) return match.result;
  if (match.winnerId) return match.winnerId; // legacy
  return null;
}
function isDecided(match) {
  return matchResult(match) !== null;
}

// Effective status: "finished" if a result is set; otherwise the admin-set
// status: "live", "over" (game over, awaiting result), or "upcoming" (default).
function effectiveStatus(match) {
  if (isDecided(match)) return "finished";
  if (match.status === "live") return "live";
  if (match.status === "over") return "over";
  return "upcoming";
}

// Predictions are allowed ONLY while the match is Upcoming (before it starts).
function predictionsOpen(match) {
  return effectiveStatus(match) === "upcoming";
}

// List matches enriched with prediction counts + result.
// Optional ?gameId=... filters to a single game.
app.get("/api/matches", (req, res) => {
  const db = loadDB();
  const pm = playerMap(db);
  const gameId = req.query.gameId;
  const source = gameId ? db.matches.filter((m) => m.gameId === gameId) : db.matches;
  const matches = source.map((match) => {
    const result = matchResult(match);
    const { pools, total, odds, count } = matchPool(db, match.id);
    return {
      ...match,
      result,
      isDraw: result === "draw",
      playerA: pm[match.playerAId] || null,
      playerB: pm[match.playerBId] || null,
      winner:
        result && result !== "draw" ? pm[result] || null : null,
      status: effectiveStatus(match),
      pool: pools,      // { A, B, draw } points staked
      poolTotal: total, // grand total staked
      odds,             // { A, B, draw } decimal odds (null if none)
      betCount: count,
    };
  });
  res.json(matches);
});

// ---- Email OTP auth ----
app.post("/api/auth/request-otp", async (req, res) => {
  const result = await auth.sendOtp((req.body || {}).email);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true, email: result.email });
});

app.post("/api/auth/verify-otp", (req, res) => {
  const { email, code } = req.body || {};
  const result = auth.verifyOtp(email, code);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true, token: result.token, email: result.email, name: nameFromEmail(result.email) });
});

// ---- Betting (pari-mutuel points) ----

// Wallet balance for the verified user. POST { sessionToken } -> { balance }
app.post("/api/wallet", (req, res) => {
  const email = auth.verifySession((req.body || {}).sessionToken);
  if (!email) return res.json({ verified: false, balance: null });
  const db = loadDB();
  const balance = getBalance(db, email);
  saveDB(db); // persist initialization to 100 on first access
  res.json({ verified: true, email, balance });
});

// Place a bet on a match. Body: { outcome: "A"|"B"|"draw", stake: 1..20, sessionToken }
// One bet per user per match, only while Upcoming. Deducts stake from wallet.
app.post("/api/matches/:matchId/bet", (req, res) => {
  const { outcome, stake, sessionToken } = req.body || {};
  const email = auth.verifySession(sessionToken);
  if (!email) {
    return res.status(401).json({ error: "Please verify your email before betting." });
  }
  if (!["A", "B", "draw"].includes(outcome)) {
    return res.status(400).json({ error: "Choose Player A, Player B, or Draw." });
  }
  const amt = Math.floor(Number(stake));
  if (!Number.isFinite(amt) || amt < 1 || amt > MAX_STAKE) {
    return res.status(400).json({ error: `Stake must be a whole number from 1 to ${MAX_STAKE}.` });
  }
  const db = loadDB();
  const match = db.matches.find((m) => m.id === req.params.matchId);
  if (!match) return res.status(404).json({ error: "Match not found." });
  if (!predictionsOpen(match)) {
    const s = effectiveStatus(match);
    return res.status(409).json({
      error: s === "live" ? "This match is live — betting is closed."
        : s === "over" ? "This match is over — betting is closed."
        : "Betting is closed for this match.",
    });
  }
  // One bet per match per user.
  if (db.bets.find((b) => b.matchId === match.id && b.email === email)) {
    return res.status(409).json({ error: "You already placed a bet on this match." });
  }
  const balance = getBalance(db, email);
  if (amt > balance) {
    return res.status(400).json({ error: `Not enough points. Your balance is ${balance}.` });
  }
  db.wallets[email] = balance - amt;
  db.bets.push({
    id: id(),
    matchId: match.id,
    gameId: match.gameId,
    email,
    outcome,
    stake: amt,
    ts: Date.now(),
    settled: false,
    payout: 0,
  });
  addOptIn(db, email); // auto opt-in to notifications on first bet
  saveDB(db);
  broadcast("bets", { matchId: match.id, gameId: match.gameId });
  res.status(201).json({ ok: true, balance: db.wallets[email] });
});

// The verified user's own bets: { matchId: { outcome, stake, settled, payout } }
app.post("/api/my-bets", (req, res) => {
  const email = auth.verifySession((req.body || {}).sessionToken);
  if (!email) return res.json({ bets: {}, balance: null });
  const db = loadDB();
  const bets = {};
  db.bets
    .filter((b) => b.email === email)
    .forEach((b) => (bets[b.matchId] = {
      outcome: b.outcome, stake: b.stake, settled: b.settled, payout: b.payout,
    }));
  res.json({ bets, balance: getBalance(db, email) });
});

// ---- Notification opt-in (email) ----
// Get the requester's current opt-in status.
app.post("/api/notifications/status", (req, res) => {
  const email = auth.verifySession((req.body || {}).sessionToken);
  if (!email) return res.json({ verified: false, optedIn: false });
  const db = loadDB();
  res.json({ verified: true, email, optedIn: isOptedIn(db, email) });
});

// Set the requester's opt-in status. Body: { sessionToken, optIn: boolean }
app.post("/api/notifications/set", (req, res) => {
  const { sessionToken, optIn } = req.body || {};
  const email = auth.verifySession(sessionToken);
  if (!email) {
    return res.status(401).json({ error: "Please verify your email to change notifications." });
  }
  const db = loadDB();
  if (optIn) addOptIn(db, email);
  else removeOptIn(db, email);
  saveDB(db);
  res.json({ ok: true, optedIn: isOptedIn(db, email) });
});

// Most-backed players: total points staked on each player across bets.
// Optional ?gameId=... scopes to one game. A player is "backed" when someone
// bets on them (outcome A => playerA, B => playerB). Draw stakes are separate.
app.get("/api/leaderboard/backed", (req, res) => {
  const db = loadDB();
  const gameId = req.query.gameId;
  const scopedMatches = gameId ? db.matches.filter((m) => m.gameId === gameId) : db.matches;
  const matchById = {};
  scopedMatches.forEach((m) => (matchById[m.id] = m));
  const staked = {}; // playerId -> points staked on them
  let drawStake = 0;
  db.bets.forEach((b) => {
    const m = matchById[b.matchId];
    if (!m) return;
    if (b.outcome === "A") staked[m.playerAId] = (staked[m.playerAId] || 0) + b.stake;
    else if (b.outcome === "B") staked[m.playerBId] = (staked[m.playerBId] || 0) + b.stake;
    else drawStake += b.stake;
  });
  const board = db.players
    .map((p) => ({ ...p, staked: staked[p.id] || 0 }))
    .filter((p) => p.staked > 0)
    .sort((a, b) => b.staked - a.staked);
  res.json({ players: board, drawStake });
});

// Top bettors by net winnings (payouts received minus stakes wagered) on
// SETTLED bets, plus current balance. Optional ?gameId=... scopes to one game.
app.get("/api/leaderboard/bettors", (req, res) => {
  const db = loadDB();
  const gameId = req.query.gameId;
  const inScope = (b) => !gameId || b.gameId === gameId;
  const byEmail = {}; // email -> { staked, won, netProfit }
  db.bets.filter(inScope).forEach((b) => {
    const e = b.email;
    byEmail[e] = byEmail[e] || { staked: 0, won: 0 };
    if (b.settled) {
      byEmail[e].staked += b.stake;
      byEmail[e].won += b.payout || 0;
    }
  });
  const board = Object.entries(byEmail)
    .map(([email, s]) => ({
      email,
      name: nameFromEmail(email),
      net: s.won - s.staked,
      won: s.won,
      staked: s.staked,
      balance: getBalance(db, email),
    }))
    .filter((x) => x.staked > 0)
    .sort((a, b) => b.net - a.net || b.balance - a.balance);
  res.json(board);
});

// ---- Community posts (pre-moderated: hidden until an admin approves) ----
// Posts without an explicit status are treated as approved (backward compat).
function isApproved(p) {
  return p.status === "approved" || p.status === undefined;
}

// Public shape of a post: never leak the real email; show "Anonymous" when chosen.
function publicPost(p) {
  return {
    id: p.id,
    text: p.text,
    ts: p.ts,
    anonymous: !!p.anonymous,
    author: p.anonymous ? "Anonymous" : p.author,
  };
}

// Public feed: only approved posts, with identity stripped for anonymous ones.
app.get("/api/posts", (req, res) => {
  const db = loadDB();
  const posts = [...db.posts]
    .filter(isApproved)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 200)
    .map(publicPost);
  res.json(posts);
});

// Which approved posts belong to the requester (so the author sees a delete
// button on their own posts, including anonymous ones). Returns { ids: [...] }.
app.post("/api/posts/mine", (req, res) => {
  const email = auth.verifySession((req.body || {}).sessionToken);
  if (!email) return res.json({ ids: [] });
  const db = loadDB();
  const ids = db.posts
    .filter((p) => isApproved(p) && p.email === email)
    .map((p) => p.id);
  res.json({ ids });
});

app.post("/api/posts", (req, res) => {
  const { text, sessionToken, anonymous } = req.body || {};
  const email = auth.verifySession(sessionToken);
  if (!email) {
    return res.status(401).json({ error: "Please verify your email before posting." });
  }
  const body = String(text || "").trim();
  if (!body) return res.status(400).json({ error: "Post cannot be empty." });
  if (body.length > 500) {
    return res.status(400).json({ error: "Post is too long (max 500 characters)." });
  }
  const db = loadDB();
  const post = {
    id: id(),
    text: body,
    email, // real identity, kept internally for moderation (never sent to public feed)
    author: nameFromEmail(email),
    anonymous: !!anonymous, // if true, public feed shows "Anonymous"
    ts: Date.now(),
    status: "pending", // awaits admin approval before it's visible
  };
  db.posts.push(post);
  saveDB(db);
  broadcast("moderation", { pending: post.id }); // notify admin queues
  res.status(201).json({ id: post.id, status: "pending" });
});

// Admin: list pending posts (moderation queue).
// Anonymous posts are masked here too — the real email stays in the data file
// but is not sent to the admin UI, so moderation is truly blind for anon posts.
app.get("/api/admin/posts/pending", requireAdmin, (req, res) => {
  const db = loadDB();
  const pending = db.posts
    .filter((p) => p.status === "pending")
    .sort((a, b) => a.ts - b.ts) // oldest first (FIFO review)
    .map((p) =>
      p.anonymous
        ? { id: p.id, text: p.text, ts: p.ts, anonymous: true, author: "Anonymous" }
        : { id: p.id, text: p.text, ts: p.ts, anonymous: false, author: p.author, email: p.email }
    );
  res.json(pending);
});

// Admin: approve a pending post -> becomes visible in the public feed
app.post("/api/admin/posts/:postId/approve", requireAdmin, (req, res) => {
  const db = loadDB();
  const post = db.posts.find((p) => p.id === req.params.postId);
  if (!post) return res.status(404).json({ error: "Post not found." });
  post.status = "approved";
  post.ts = Date.now(); // surface freshly-approved posts at the top
  saveDB(db);
  broadcast("posts", { approved: post.id });      // public feed refresh
  broadcast("moderation", { approved: post.id }); // admin queue refresh
  res.json({ ok: true });
});

// Admin: reject (discard) a pending post
app.post("/api/admin/posts/:postId/reject", requireAdmin, (req, res) => {
  const db = loadDB();
  const before = db.posts.length;
  db.posts = db.posts.filter((p) => p.id !== req.params.postId);
  if (db.posts.length === before) {
    return res.status(404).json({ error: "Post not found." });
  }
  saveDB(db);
  broadcast("moderation", { rejected: req.params.postId });
  res.json({ ok: true });
});

// Admin: delete an already-approved post
app.delete("/api/admin/posts/:postId", requireAdmin, (req, res) => {
  const db = loadDB();
  db.posts = db.posts.filter((p) => p.id !== req.params.postId);
  saveDB(db);
  broadcast("posts", { deleted: req.params.postId });
  broadcast("moderation", { deleted: req.params.postId });
  res.json({ ok: true });
});

// Delete a post: allowed if the requester is the author (session token matching
// the post's email) OR an admin (x-admin-key header). Works for anonymous posts too.
app.delete("/api/posts/:postId", (req, res) => {
  const db = loadDB();
  const post = db.posts.find((p) => p.id === req.params.postId);
  if (!post) return res.status(404).json({ error: "Post not found." });

  const isAdmin = req.header("x-admin-key") === ADMIN_KEY;
  const requesterEmail = auth.verifySession((req.body || {}).sessionToken);
  const isOwner = requesterEmail && requesterEmail === post.email;

  if (!isAdmin && !isOwner) {
    return res.status(403).json({ error: "You can only delete your own posts." });
  }
  db.posts = db.posts.filter((p) => p.id !== req.params.postId);
  saveDB(db);
  broadcast("posts", { deleted: req.params.postId });
  broadcast("moderation", { deleted: req.params.postId });
  res.json({ ok: true });
});

// ---------- Per-game chat (live, non-anonymous, verified users only) ----------
const CHAT_LIMIT = 200;

function publicChatMsg(m) {
  // Never expose the raw email to clients; show the display name only.
  return { id: m.id, text: m.text, author: m.author, ts: m.ts };
}

// Last 200 messages for a game, oldest first (chat order). Requires ?gameId=...
app.get("/api/chat", (req, res) => {
  const db = loadDB();
  const gameId = req.query.gameId;
  const msgs = [...db.chat]
    .filter((m) => !gameId || m.gameId === gameId)
    .sort((a, b) => a.ts - b.ts)
    .slice(-CHAT_LIMIT)
    .map(publicChatMsg);
  res.json(msgs);
});

// Send a message to a game's chat. Requires a verified email + gameId.
app.post("/api/chat", (req, res) => {
  const { text, sessionToken, gameId } = req.body || {};
  const email = auth.verifySession(sessionToken);
  if (!email) {
    return res.status(401).json({ error: "Please verify your email before chatting." });
  }
  if (!gameId) return res.status(400).json({ error: "gameId is required." });
  const db = loadDB();
  if (!db.games.find((g) => g.id === gameId)) {
    return res.status(404).json({ error: "Game not found." });
  }
  const body = String(text || "").trim();
  if (!body) return res.status(400).json({ error: "Message cannot be empty." });
  if (body.length > 500) {
    return res.status(400).json({ error: "Message is too long (max 500 characters)." });
  }
  const msg = {
    id: id(),
    gameId,
    text: body,
    email, // internal, for own-delete authorization; never sent to clients
    author: nameFromEmail(email),
    ts: Date.now(),
  };
  db.chat.push(msg);
  // Trim per-game storage cap.
  const gameMsgs = db.chat.filter((m) => m.gameId === gameId);
  if (gameMsgs.length > CHAT_LIMIT * 3) {
    const keepIds = new Set(gameMsgs.slice(-CHAT_LIMIT * 2).map((m) => m.id));
    db.chat = db.chat.filter((m) => m.gameId !== gameId || keepIds.has(m.id));
  }
  saveDB(db);
  broadcast("chat", { id: msg.id, gameId });
  res.status(201).json(publicChatMsg(msg));
});

// Whether the requester owns a message (for the frontend to show a delete button).
// POST { sessionToken } -> { ids: [messageIds owned by this email] }
app.post("/api/chat/mine", (req, res) => {
  const email = auth.verifySession((req.body || {}).sessionToken);
  if (!email) return res.json({ ids: [] });
  const db = loadDB();
  const ids = db.chat.filter((m) => m.email === email).map((m) => m.id);
  res.json({ ids });
});

// Delete a message: allowed if the requester is the author (valid session token
// matching the message's email) OR an admin (x-admin-key header).
app.delete("/api/chat/:msgId", (req, res) => {
  const db = loadDB();
  const msg = db.chat.find((m) => m.id === req.params.msgId);
  if (!msg) return res.status(404).json({ error: "Message not found." });

  const isAdmin = req.header("x-admin-key") === ADMIN_KEY;
  const requesterEmail = auth.verifySession((req.body || {}).sessionToken);
  const isOwner = requesterEmail && requesterEmail === msg.email;

  if (!isAdmin && !isOwner) {
    return res.status(403).json({ error: "You can only delete your own messages." });
  }
  db.chat = db.chat.filter((m) => m.id !== req.params.msgId);
  saveDB(db);
  broadcast("chat", { deleted: req.params.msgId, gameId: msg.gameId });
  res.json({ ok: true });
});

// ---------- Admin API ----------
app.post("/api/admin/verify", (req, res) => {
  const { key } = req.body || {};
  if (key === ADMIN_KEY) return res.json({ ok: true });
  res.status(401).json({ error: "Invalid admin key." });
});

// ---- Admin: games CRUD ----
app.post("/api/admin/games", requireAdmin, (req, res) => {
  const { name, emoji, description } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Game name is required." });
  const db = loadDB();
  const game = {
    id: id(),
    name: name.trim(),
    emoji: (emoji || "\uD83C\uDFAE").trim(), // default 🎮
    description: (description || "").trim(),
    ts: Date.now(),
  };
  db.games.push(game);
  saveDB(db);
  broadcast("games", { id: game.id });
  res.status(201).json(game);
});

app.put("/api/admin/games/:gameId", requireAdmin, (req, res) => {
  const { name, emoji, description } = req.body || {};
  const db = loadDB();
  const game = db.games.find((g) => g.id === req.params.gameId);
  if (!game) return res.status(404).json({ error: "Game not found." });
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: "Game name cannot be empty." });
    game.name = name.trim();
  }
  if (emoji !== undefined) game.emoji = (emoji || "\uD83C\uDFAE").trim();
  if (description !== undefined) game.description = description.trim();
  saveDB(db);
  broadcast("games", { id: game.id });
  res.json({ ok: true, game });
});

// Delete a game and all its matches, predictions for those matches, and chat.
app.delete("/api/admin/games/:gameId", requireAdmin, (req, res) => {
  const db = loadDB();
  const gid = req.params.gameId;
  if (!db.games.find((g) => g.id === gid)) {
    return res.status(404).json({ error: "Game not found." });
  }
  const matchIds = new Set(db.matches.filter((m) => m.gameId === gid).map((m) => m.id));
  db.games = db.games.filter((g) => g.id !== gid);
  db.matches = db.matches.filter((m) => m.gameId !== gid);
  db.predictions = db.predictions.filter((v) => !matchIds.has(v.matchId));
  db.chat = db.chat.filter((c) => c.gameId !== gid);
  saveDB(db);
  broadcast("games", { deleted: gid });
  broadcast("matches", {});
  res.json({ ok: true });
});

app.post("/api/admin/players", requireAdmin, (req, res) => {
  const { name, org } = req.body || {};
  if (!name) return res.status(400).json({ error: "Player name is required." });
  const db = loadDB();
  const player = { id: id(), name: name.trim(), org: (org || "").trim() };
  db.players.push(player);
  saveDB(db);
  broadcast("matches", {});
  res.status(201).json(player);
});

app.delete("/api/admin/players/:playerId", requireAdmin, (req, res) => {
  const db = loadDB();
  const pid = req.params.playerId;
  db.players = db.players.filter((p) => p.id !== pid);
  db.predictions = db.predictions.filter((v) => v.playerId !== pid);
  db.matches = db.matches.filter(
    (m) => m.playerAId !== pid && m.playerBId !== pid
  );
  saveDB(db);
  broadcast("matches", {});
  res.json({ ok: true });
});

app.post("/api/admin/matches", requireAdmin, (req, res) => {
  const { gameId, playerAId, playerBId, time, day, location } = req.body || {};
  if (!gameId) {
    return res.status(400).json({ error: "A game is required." });
  }
  if (!playerAId || !playerBId) {
    return res.status(400).json({ error: "Both players are required." });
  }
  if (playerAId === playerBId) {
    return res.status(400).json({ error: "A match needs two different players." });
  }
  const db = loadDB();
  if (!db.games.find((g) => g.id === gameId)) {
    return res.status(400).json({ error: "Unknown game." });
  }
  const ids = db.players.map((p) => p.id);
  if (!ids.includes(playerAId) || !ids.includes(playerBId)) {
    return res.status(400).json({ error: "Unknown player(s)." });
  }
  const match = {
    id: id(),
    gameId,
    playerAId,
    playerBId,
    time: (time || "").trim(),
    day: (day || "Today").trim(),
    location: (location || "").trim(),
    status: "upcoming",
    result: null,
    winnerId: null,
  };
  db.matches.push(match);
  saveDB(db);
  broadcast("matches", { id: match.id, gameId });
  res.status(201).json(match);
});

app.delete("/api/admin/matches/:matchId", requireAdmin, (req, res) => {
  const db = loadDB();
  const mid = req.params.matchId;
  db.matches = db.matches.filter((m) => m.id !== mid);
  db.predictions = db.predictions.filter((v) => v.matchId !== mid);
  saveDB(db);
  broadcast("matches", { deleted: mid });
  res.json({ ok: true });
});

// Set / update the result of a match: a player win, a "draw", or clear.
// Accepts { result } ("draw" | playerId | "") ; also accepts legacy { winnerId }.
app.post("/api/admin/matches/:matchId/winner", requireAdmin, (req, res) => {
  const body = req.body || {};
  const result = body.result !== undefined ? body.result : body.winnerId;
  const db = loadDB();
  const match = db.matches.find((m) => m.id === req.params.matchId);
  if (!match) return res.status(404).json({ error: "Match not found." });

  const val = result || null; // "" -> null (clear)
  if (
    val &&
    val !== "draw" &&
    val !== match.playerAId &&
    val !== match.playerBId
  ) {
    return res
      .status(400)
      .json({ error: "Result must be one of the two players or a draw." });
  }

  // If this match was already settled, reverse the old payouts before applying
  // a new result (handles changing or clearing the result).
  if (isDecided(match)) {
    unsettleMatch(db, match);
  }

  match.result = val; // "draw" | playerId | null
  match.winnerId = val && val !== "draw" ? val : null; // keep legacy field in sync
  // Setting a result finishes the match; clearing it reverts to upcoming.
  if (val) match.status = "finished";
  else if (match.status === "finished") match.status = "upcoming";

  // Settle bets (pari-mutuel payout) when a result is set.
  let settlement = null;
  if (val) settlement = settleMatch(db, match);

  saveDB(db);
  broadcast("winner", { matchId: match.id, result: match.result });
  broadcast("bets", { matchId: match.id, gameId: match.gameId });
  broadcast("matches", { id: match.id });
  res.json({ ok: true, match, settlement });
});

// Set the live/upcoming status of a match (does not affect the result).
app.post("/api/admin/matches/:matchId/status", requireAdmin, (req, res) => {
  const { status } = req.body || {};
  if (!["upcoming", "live", "over"].includes(status)) {
    return res.status(400).json({ error: "Status must be 'upcoming', 'live', or 'over'." });
  }
  const db = loadDB();
  const match = db.matches.find((m) => m.id === req.params.matchId);
  if (!match) return res.status(404).json({ error: "Match not found." });
  if (isDecided(match)) {
    return res
      .status(409)
      .json({ error: "This match is finished (has a result). Clear the result first to change status." });
  }
  const wasLive = match.status === "live";
  match.status = status;
  saveDB(db);
  broadcast("matches", { id: match.id });

  // Only notify on the TRANSITION into live (not if it was already live).
  let notify = null;
  if (status === "live" && !wasLive) {
    const baseUrl =
      process.env.PUBLIC_URL ||
      `${req.protocol}://${req.get("host")}`;
    // Fire-and-forget so the admin response is instant.
    notifyMatchLive(db, match, baseUrl).catch((e) =>
      console.error("[notify] error:", e.message)
    );
    notify = { queued: true, recipients: db.notifyOptIns.length };
  }
  res.json({ ok: true, match, notify });
});

app.listen(PORT, () => {
  console.log(`SnapGames server running at http://localhost:${PORT}`);
  console.log(`Admin key: ${ADMIN_KEY}`);
});
