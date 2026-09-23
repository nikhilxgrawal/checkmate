require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
const XLSX = require("xlsx");
const multer = require("multer");
const auth = require("./auth");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "acevector2026";
const STARTING_BALANCE = Number(process.env.STARTING_BALANCE || 10000);
// MAX_BID = 0 (or unset) means no cap — a user may bid up to their balance.
const MAX_BID = Number(process.env.MAX_BID || 0);

// Parse JSON for everything EXCEPT multipart/form-data (file uploads), which
// multer handles per-route. type:() => true otherwise parses even when the
// client sends a wrong/missing Content-Type.
app.use(express.json({
  type: (req) => !String(req.headers["content-type"] || "").includes("multipart/form-data"),
  limit: "100kb",
}));
app.use(express.static(path.join(__dirname, "public")));

// ---------- Data layer (MySQL) ----------
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  // Respect an explicitly-set empty password (root with no password) — only
  // fall back to "root" when the var is truly undefined.
  password: process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : "root",
  database: process.env.DB_NAME || "checkmate",
  waitForConnections: true,
  connectionLimit: 10,
});

function id() {
  return crypto.randomBytes(8).toString("hex");
}

// Load the whole dataset into the same in-memory shape the route handlers use
// (db.games / db.players / db.matches / db.bids / db.wallets / db.posts /
// db.chat / db.notifyOptIns). Handlers mutate this object; saveDB persists it.
async function loadDB() {
  const [games] = await pool.query("SELECT * FROM games");
  const [players] = await pool.query("SELECT * FROM players");
  const [matches] = await pool.query("SELECT * FROM matches");
  const [bids] = await pool.query("SELECT * FROM bids");
  const [walletRows] = await pool.query("SELECT * FROM wallets");
  const [posts] = await pool.query("SELECT * FROM posts");
  const [chat] = await pool.query("SELECT * FROM chat");
  const [optins] = await pool.query("SELECT email FROM notify_optins");

  // Normalize MySQL tinyint(1) to boolean for posts / bids.
  posts.forEach((p) => (p.anonymous = !!p.anonymous));
  bids.forEach((b) => (b.settled = !!b.settled));

  const wallets = {};
  walletRows.forEach((w) => (wallets[w.email] = w.balance));

  return {
    games, players, matches, bids, wallets, posts, chat,
    notifyOptIns: optins.map((o) => o.email),
  };
}

// Persist the whole dataset back in a single transaction (delete-all + reinsert
// keeps the handler code storage-agnostic). Fine for this app's small scale.
async function saveDB(db) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Children/independent tables first.
    await conn.query("DELETE FROM bids");
    await conn.query("DELETE FROM chat");
    await conn.query("DELETE FROM posts");
    await conn.query("DELETE FROM matches");
    await conn.query("DELETE FROM players");
    await conn.query("DELETE FROM games");
    await conn.query("DELETE FROM wallets");
    await conn.query("DELETE FROM notify_optins");

    for (const g of db.games) {
      await conn.query(
        "INSERT INTO games (id, name, emoji, description, ts) VALUES (?, ?, ?, ?, ?)",
        [g.id, g.name, g.emoji || "🎮", g.description || "", g.ts || Date.now()]
      );
    }
    for (const p of db.players) {
      await conn.query("INSERT INTO players (id, name, org) VALUES (?, ?, ?)", [
        p.id, p.name, p.org || "",
      ]);
    }
    for (const m of db.matches) {
      await conn.query(
        `INSERT INTO matches (id, gameId, playerAId, playerBId, time, day, location, status, result, winnerId, startAt, endAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [m.id, m.gameId, m.playerAId, m.playerBId, m.time || "", m.day || "Today",
         m.location || "", m.status || "upcoming", m.result || null, m.winnerId || null,
         m.startAt != null ? m.startAt : null, m.endAt != null ? m.endAt : null]
      );
    }
    for (const b of db.bids) {
      await conn.query(
        `INSERT INTO bids (id, matchId, gameId, email, outcome, stake, ts, settled, payout)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [b.id, b.matchId, b.gameId, b.email, b.outcome, b.stake, b.ts,
         b.settled ? 1 : 0, b.payout || 0]
      );
    }
    for (const email of Object.keys(db.wallets)) {
      await conn.query("INSERT INTO wallets (email, balance) VALUES (?, ?)", [
        email, db.wallets[email],
      ]);
    }
    for (const p of db.posts) {
      await conn.query(
        `INSERT INTO posts (id, text, email, author, anonymous, ts, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [p.id, p.text, p.email, p.author, p.anonymous ? 1 : 0, p.ts, p.status || "pending"]
      );
    }
    for (const c of db.chat) {
      await conn.query(
        `INSERT INTO chat (id, gameId, text, email, author, ts) VALUES (?, ?, ?, ?, ?, ?)`,
        [c.id, c.gameId, c.text, c.email, c.author, c.ts]
      );
    }
    for (const email of db.notifyOptIns) {
      await conn.query("INSERT INTO notify_optins (email) VALUES (?)", [email]);
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// Seed the tournament data if the DB is empty.
async function seedIfEmpty() {
  const [[{ c }]] = await pool.query("SELECT COUNT(*) AS c FROM games");
  const [[{ mc }]] = await pool.query("SELECT COUNT(*) AS mc FROM matches");
  if (c > 0 || mc > 0) return;

  const chess = {
    id: id(), name: "Chess", emoji: "\u265F\uFE0F",
    description: "The Acevector Chess Tournament", ts: Date.now(),
  };
  const players = [
    { id: id(), name: "Sandeep Singh Sachdeva", org: "Snapdeal" },
    { id: id(), name: "Rishi Sharma", org: "Unicommerce" },
    { id: id(), name: "Anshuman Sengar", org: "Unicommerce" },
    { id: id(), name: "Sarthak", org: "Snapdeal" },
  ];
  const matches = [
    { id: id(), gameId: chess.id, playerAId: players[0].id, playerBId: players[1].id,
      time: "1:30 PM - 2:00 PM", day: "Today", location: "Sky Deck - Tower A",
      status: "upcoming", result: null, winnerId: null },
    { id: id(), gameId: chess.id, playerAId: players[2].id, playerBId: players[3].id,
      time: "4:30 PM - 5:00 PM", day: "Today", location: "Sky Deck - Tower A",
      status: "upcoming", result: null, winnerId: null },
  ];
  await saveDB({
    games: [chess], players, matches, bids: [], wallets: {},
    posts: [], chat: [], notifyOptIns: [],
  });
  console.log("[seed] inserted default Chess game + 2 matches");
}

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

// Wrap async route handlers so thrown errors return 500 instead of hanging.
function h(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    console.error("[error]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error." });
  });
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

// ---- Notification opt-in helpers ----
function isOptedIn(db, email) { return db.notifyOptIns.includes(email); }
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

function nameFromEmail(email) {
  const local = String(email || "").split("@")[0];
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") || email;
}

// Parse a start/end time into epoch ms. Accepts:
//  - a number (epoch ms) or numeric string
//  - "YYYY-MM-DD HH:MM" / "YYYY-MM-DDTHH:MM" (interpreted as local/IST time)
//  - a JS Date (from an Excel date cell)
// Returns null if empty/unparseable.
function parseWhen(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v > 1e12 ? v : Math.round(v); // assume ms
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{10,}$/.test(s)) return Number(s); // epoch ms as string
  // Normalize "YYYY-MM-DD HH:MM[:SS]" to ISO local
  const iso = s.replace(" ", "T");
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

// ---- Wallet / bid helpers ----
function getBalance(db, email) {
  if (db.wallets[email] === undefined) db.wallets[email] = STARTING_BALANCE;
  return db.wallets[email];
}

// Pari-mutuel pool for a match: points staked per outcome, live decimal odds
// (total / outcomePool), and grand total.
function matchPool(db, matchId) {
  const bids = db.bids.filter((b) => b.matchId === matchId);
  const pools = { A: 0, B: 0, draw: 0 };
  bids.forEach((b) => { pools[b.outcome] = (pools[b.outcome] || 0) + b.stake; });
  const total = pools.A + pools.B + pools.draw;
  const odds = {
    A: pools.A > 0 ? +(total / pools.A).toFixed(2) : null,
    B: pools.B > 0 ? +(total / pools.B).toFixed(2) : null,
    draw: pools.draw > 0 ? +(total / pools.draw).toFixed(2) : null,
  };
  return { pools, total, odds, count: bids.length };
}

function winningOutcome(match) {
  const r = matchResult(match);
  if (!r) return null;
  if (r === "draw") return "draw";
  if (r === match.playerAId) return "A";
  if (r === match.playerBId) return "B";
  return null;
}

// Pari-mutuel settlement: winners split the ENTIRE pool proportional to stake;
// losers forfeit. Credits payouts to wallets.
function settleMatch(db, match) {
  const outcome = winningOutcome(match);
  if (!outcome) return { settled: false };
  const bids = db.bids.filter((b) => b.matchId === match.id);
  const total = bids.reduce((s, b) => s + b.stake, 0);
  const winners = bids.filter((b) => b.outcome === outcome);
  const winnerStake = winners.reduce((s, b) => s + b.stake, 0);
  let paid = 0;
  if (winnerStake > 0) {
    let remaining = total;
    winners.sort((a, b) => b.stake - a.stake).forEach((b, i) => {
      let share;
      if (i === winners.length - 1) share = remaining;
      else { share = Math.floor((b.stake / winnerStake) * total); remaining -= share; }
      db.wallets[b.email] = (db.wallets[b.email] || 0) + share;
      b.payout = share;
      b.settled = true;
      paid += share;
    });
  }
  bids.forEach((b) => { b.settled = true; if (b.outcome !== outcome) b.payout = 0; });
  return { settled: true, outcome, total, winnerStake, paid, noWinners: winnerStake === 0 };
}

// Reverse a settlement (reclaim payouts) when a result changes or is cleared.
function unsettleMatch(db, match) {
  db.bids.filter((b) => b.matchId === match.id && b.settled).forEach((b) => {
    if (b.payout) db.wallets[b.email] = (db.wallets[b.email] || 0) - b.payout;
    b.payout = 0;
    b.settled = false;
  });
}

// A match is "decided" when the admin set a result.
function matchResult(match) {
  if (match.result) return match.result;
  if (match.winnerId) return match.winnerId; // legacy
  return null;
}
function isDecided(match) { return matchResult(match) !== null; }
function effectiveStatus(match) {
  if (isDecided(match)) return "finished";
  if (match.status === "live") return "live";
  if (match.status === "over") return "over";
  return "upcoming";
}
// Bids are allowed ONLY while the match is Upcoming.
function biddingOpen(match) { return effectiveStatus(match) === "upcoming"; }

// ---------- Public API ----------

app.get("/api/players", h(async (req, res) => {
  const db = await loadDB();
  res.json(db.players);
}));

// ---- Games ----
function gameSummary(db, g) {
  const gameMatches = db.matches.filter((m) => m.gameId === g.id);
  const live = gameMatches.filter((m) => effectiveStatus(m) === "live").length;
  const upcoming = gameMatches.filter((m) => effectiveStatus(m) === "upcoming").length;
  const completed = gameMatches.filter(
    (m) => effectiveStatus(m) === "finished" || effectiveStatus(m) === "over"
  ).length;
  return { ...g, matchCount: gameMatches.length, liveCount: live, upcomingCount: upcoming, completedCount: completed };
}

app.get("/api/games", h(async (req, res) => {
  const db = await loadDB();
  const games = db.games
    .map((g) => gameSummary(db, g))
    .sort((a, b) => b.liveCount - a.liveCount || (a.ts || 0) - (b.ts || 0));
  res.json(games);
}));

app.get("/api/games/:gameId", h(async (req, res) => {
  const db = await loadDB();
  const g = db.games.find((x) => x.id === req.params.gameId);
  if (!g) return res.status(404).json({ error: "Game not found." });
  res.json(gameSummary(db, g));
}));

app.get("/api/stats", h(async (req, res) => {
  const db = await loadDB();
  const liveMatches = db.matches.filter((m) => effectiveStatus(m) === "live").length;
  const pointsWagered = db.bids.reduce((s, b) => s + b.stake, 0);
  res.json({
    games: db.games.length,
    matches: db.matches.length,
    liveMatches,
    bids: db.bids.length,
    pointsWagered,
    players: db.players.length,
  });
}));

// List matches enriched with bid pool/odds + result. Optional ?gameId=...
app.get("/api/matches", h(async (req, res) => {
  const db = await loadDB();
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
      winner: result && result !== "draw" ? pm[result] || null : null,
      status: effectiveStatus(match),
      pool: pools,
      poolTotal: total,
      odds,
      betCount: count,
    };
  });
  res.json(matches);
}));

// ---- Email OTP auth ----
app.post("/api/auth/request-otp", h(async (req, res) => {
  const result = await auth.sendOtp((req.body || {}).email);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true, email: result.email });
}));

app.post("/api/auth/verify-otp", h(async (req, res) => {
  const { email, code } = req.body || {};
  const result = auth.verifyOtp(email, code);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  // Auto opt-in to match notifications on successful login/verification.
  let optedIn = false;
  try {
    const db = await loadDB();
    const added = addOptIn(db, result.email);
    getBalance(db, result.email); // ensure a wallet exists on first login
    if (added || db.wallets[result.email] !== undefined) await saveDB(db);
    optedIn = isOptedIn(db, result.email);
  } catch (e) {
    console.error("[verify-otp] opt-in error:", e.message);
  }
  res.json({
    ok: true, token: result.token, email: result.email,
    name: nameFromEmail(result.email), notifyOptedIn: optedIn,
  });
}));

// ---- Bidding (pari-mutuel points) ----

// Wallet balance for the verified user.
app.post("/api/wallet", h(async (req, res) => {
  const email = auth.verifySession((req.body || {}).sessionToken);
  if (!email) return res.json({ verified: false, balance: null });
  const db = await loadDB();
  const balance = getBalance(db, email);
  await saveDB(db); // persist wallet init to STARTING_BALANCE on first access
  res.json({ verified: true, email, balance });
}));

// Place a bid on a match. Body: { outcome: "A"|"B"|"draw", stake: 1..MAX_BID, sessionToken }
// One bid per user per match, only while Upcoming. Deducts stake from wallet.
app.post("/api/matches/:matchId/bid", h(async (req, res) => {
  const { outcome, stake, sessionToken } = req.body || {};
  const email = auth.verifySession(sessionToken);
  if (!email) return res.status(401).json({ error: "Please verify your email before bidding." });
  if (!["A", "B", "draw"].includes(outcome)) {
    return res.status(400).json({ error: "Choose Player A, Player B, or Draw." });
  }
  const amt = Math.floor(Number(stake));
  if (!Number.isFinite(amt) || amt < 1) {
    return res.status(400).json({ error: "Bid must be a whole number of at least ₹1." });
  }
  if (MAX_BID > 0 && amt > MAX_BID) {
    return res.status(400).json({ error: `Bid cannot exceed ₹${MAX_BID}.` });
  }
  const db = await loadDB();
  const match = db.matches.find((m) => m.id === req.params.matchId);
  if (!match) return res.status(404).json({ error: "Match not found." });
  if (!biddingOpen(match)) {
    const s = effectiveStatus(match);
    return res.status(409).json({
      error: s === "live" ? "This match is live — bidding is closed."
        : s === "over" ? "This match is over — bidding is closed."
        : "Bidding is closed for this match.",
    });
  }
  if (db.bids.find((b) => b.matchId === match.id && b.email === email)) {
    return res.status(409).json({ error: "You already placed a bid on this match." });
  }
  const balance = getBalance(db, email);
  if (amt > balance) {
    return res.status(400).json({ error: `Not enough balance. You have ₹${balance}.` });
  }
  db.wallets[email] = balance - amt;
  db.bids.push({
    id: id(), matchId: match.id, gameId: match.gameId, email,
    outcome, stake: amt, ts: Date.now(), settled: false, payout: 0,
  });
  addOptIn(db, email);
  await saveDB(db);
  broadcast("bids", { matchId: match.id, gameId: match.gameId });
  res.status(201).json({ ok: true, balance: db.wallets[email] });
}));

// The verified user's own bids: { matchId: { outcome, stake, settled, payout } } + balance.
app.post("/api/my-bids", h(async (req, res) => {
  const email = auth.verifySession((req.body || {}).sessionToken);
  if (!email) return res.json({ bids: {}, balance: null });
  const db = await loadDB();
  const bids = {};
  db.bids.filter((b) => b.email === email).forEach((b) => (bids[b.matchId] = {
    outcome: b.outcome, stake: b.stake, settled: b.settled, payout: b.payout,
  }));
  res.json({ bids, balance: getBalance(db, email) });
}));

// ---- Notification opt-in ----
app.post("/api/notifications/status", h(async (req, res) => {
  const email = auth.verifySession((req.body || {}).sessionToken);
  if (!email) return res.json({ verified: false, optedIn: false });
  const db = await loadDB();
  res.json({ verified: true, email, optedIn: isOptedIn(db, email) });
}));

app.post("/api/notifications/set", h(async (req, res) => {
  const { sessionToken, optIn } = req.body || {};
  const email = auth.verifySession(sessionToken);
  if (!email) return res.status(401).json({ error: "Please verify your email to change notifications." });
  const db = await loadDB();
  if (optIn) addOptIn(db, email); else removeOptIn(db, email);
  await saveDB(db);
  res.json({ ok: true, optedIn: isOptedIn(db, email) });
}));

// ---- Leaderboards ----

// Match winners standings: players ranked by results. Win = 1.0, draw = 0.5 each.
// Optional ?gameId=... scopes to one game.
app.get("/api/leaderboard/winners", h(async (req, res) => {
  const db = await loadDB();
  const gameId = req.query.gameId;
  const scoped = gameId ? db.matches.filter((m) => m.gameId === gameId) : db.matches;
  const stats = {}; // playerId -> { wins, draws, points }
  const ensure = (pid) => (stats[pid] = stats[pid] || { wins: 0, draws: 0, points: 0 });
  scoped.forEach((m) => {
    const r = matchResult(m);
    if (!r) return;
    if (r === "draw") {
      ensure(m.playerAId).draws += 1; ensure(m.playerAId).points += 0.5;
      ensure(m.playerBId).draws += 1; ensure(m.playerBId).points += 0.5;
    } else {
      ensure(r).wins += 1; ensure(r).points += 1;
    }
  });
  const board = db.players
    .map((p) => ({
      ...p,
      wins: stats[p.id] ? stats[p.id].wins : 0,
      draws: stats[p.id] ? stats[p.id].draws : 0,
      points: stats[p.id] ? stats[p.id].points : 0,
    }))
    .filter((p) => p.points > 0)
    .sort((a, b) => b.points - a.points || b.wins - a.wins);
  res.json(board);
}));

// Most-backed players: total points staked on each player. Optional ?gameId=...
app.get("/api/leaderboard/backed", h(async (req, res) => {
  const db = await loadDB();
  const gameId = req.query.gameId;
  const scopedMatches = gameId ? db.matches.filter((m) => m.gameId === gameId) : db.matches;
  const matchById = {};
  scopedMatches.forEach((m) => (matchById[m.id] = m));
  const staked = {};
  let drawStake = 0;
  db.bids.forEach((b) => {
    const m = matchById[b.matchId];
    if (!m) return;
    if (b.outcome === "A") staked[m.playerAId] = (staked[m.playerAId] || 0) + b.stake;
    else if (b.outcome === "B") staked[m.playerBId] = (staked[m.playerBId] || 0) + b.stake;
    else drawStake += b.stake;
  });
  const players = db.players
    .map((p) => ({ ...p, staked: staked[p.id] || 0 }))
    .filter((p) => p.staked > 0)
    .sort((a, b) => b.staked - a.staked);
  res.json({ players, drawStake });
}));

// Top bidders by net winnings on settled bids + current balance. Optional ?gameId=...
app.get("/api/leaderboard/bettors", h(async (req, res) => {
  const db = await loadDB();
  const gameId = req.query.gameId;
  const inScope = (b) => !gameId || b.gameId === gameId;
  const byEmail = {};
  db.bids.filter(inScope).forEach((b) => {
    byEmail[b.email] = byEmail[b.email] || { staked: 0, won: 0 };
    if (b.settled) { byEmail[b.email].staked += b.stake; byEmail[b.email].won += b.payout || 0; }
  });
  const board = Object.entries(byEmail)
    .map(([email, s]) => ({
      email, name: nameFromEmail(email),
      net: s.won - s.staked, won: s.won, staked: s.staked,
      balance: getBalance(db, email),
    }))
    .filter((x) => x.staked > 0)
    .sort((a, b) => b.net - a.net || b.balance - a.balance);
  res.json(board);
}));

// ---- Community posts (pre-moderated) ----
function isApproved(p) { return p.status === "approved" || p.status === undefined; }
function publicPost(p) {
  return { id: p.id, text: p.text, ts: p.ts, anonymous: !!p.anonymous, author: p.anonymous ? "Anonymous" : p.author };
}

app.get("/api/posts", h(async (req, res) => {
  const db = await loadDB();
  const posts = [...db.posts].filter(isApproved).sort((a, b) => b.ts - a.ts).slice(0, 200).map(publicPost);
  res.json(posts);
}));

app.post("/api/posts/mine", h(async (req, res) => {
  const email = auth.verifySession((req.body || {}).sessionToken);
  if (!email) return res.json({ ids: [] });
  const db = await loadDB();
  const ids = db.posts.filter((p) => isApproved(p) && p.email === email).map((p) => p.id);
  res.json({ ids });
}));

app.post("/api/posts", h(async (req, res) => {
  const { text, sessionToken, anonymous } = req.body || {};
  const email = auth.verifySession(sessionToken);
  if (!email) return res.status(401).json({ error: "Please verify your email before posting." });
  const body = String(text || "").trim();
  if (!body) return res.status(400).json({ error: "Post cannot be empty." });
  if (body.length > 500) return res.status(400).json({ error: "Post is too long (max 500 characters)." });
  const db = await loadDB();
  const post = {
    id: id(), text: body, email, author: nameFromEmail(email),
    anonymous: !!anonymous, ts: Date.now(), status: "pending",
  };
  db.posts.push(post);
  await saveDB(db);
  broadcast("moderation", { pending: post.id });
  res.status(201).json({ id: post.id, status: "pending" });
}));

app.get("/api/admin/posts/pending", requireAdmin, h(async (req, res) => {
  const db = await loadDB();
  const pending = db.posts
    .filter((p) => p.status === "pending")
    .sort((a, b) => a.ts - b.ts)
    .map((p) => p.anonymous
      ? { id: p.id, text: p.text, ts: p.ts, anonymous: true, author: "Anonymous" }
      : { id: p.id, text: p.text, ts: p.ts, anonymous: false, author: p.author, email: p.email });
  res.json(pending);
}));

app.post("/api/admin/posts/:postId/approve", requireAdmin, h(async (req, res) => {
  const db = await loadDB();
  const post = db.posts.find((p) => p.id === req.params.postId);
  if (!post) return res.status(404).json({ error: "Post not found." });
  post.status = "approved";
  post.ts = Date.now();
  await saveDB(db);
  broadcast("posts", { approved: post.id });
  broadcast("moderation", { approved: post.id });
  res.json({ ok: true });
}));

app.post("/api/admin/posts/:postId/reject", requireAdmin, h(async (req, res) => {
  const db = await loadDB();
  const before = db.posts.length;
  db.posts = db.posts.filter((p) => p.id !== req.params.postId);
  if (db.posts.length === before) return res.status(404).json({ error: "Post not found." });
  await saveDB(db);
  broadcast("moderation", { rejected: req.params.postId });
  res.json({ ok: true });
}));

app.delete("/api/admin/posts/:postId", requireAdmin, h(async (req, res) => {
  const db = await loadDB();
  db.posts = db.posts.filter((p) => p.id !== req.params.postId);
  await saveDB(db);
  broadcast("posts", { deleted: req.params.postId });
  broadcast("moderation", { deleted: req.params.postId });
  res.json({ ok: true });
}));

app.delete("/api/posts/:postId", h(async (req, res) => {
  const db = await loadDB();
  const post = db.posts.find((p) => p.id === req.params.postId);
  if (!post) return res.status(404).json({ error: "Post not found." });
  const isAdmin = req.header("x-admin-key") === ADMIN_KEY;
  const requesterEmail = auth.verifySession((req.body || {}).sessionToken);
  const isOwner = requesterEmail && requesterEmail === post.email;
  if (!isAdmin && !isOwner) return res.status(403).json({ error: "You can only delete your own posts." });
  db.posts = db.posts.filter((p) => p.id !== req.params.postId);
  await saveDB(db);
  broadcast("posts", { deleted: req.params.postId });
  broadcast("moderation", { deleted: req.params.postId });
  res.json({ ok: true });
}));

// ---------- Per-game chat ----------
const CHAT_LIMIT = 200;
function publicChatMsg(m) { return { id: m.id, text: m.text, author: m.author, ts: m.ts }; }

app.get("/api/chat", h(async (req, res) => {
  const db = await loadDB();
  const gameId = req.query.gameId;
  const msgs = [...db.chat]
    .filter((m) => !gameId || m.gameId === gameId)
    .sort((a, b) => a.ts - b.ts).slice(-CHAT_LIMIT).map(publicChatMsg);
  res.json(msgs);
}));

app.post("/api/chat", h(async (req, res) => {
  const { text, sessionToken, gameId } = req.body || {};
  const email = auth.verifySession(sessionToken);
  if (!email) return res.status(401).json({ error: "Please verify your email before chatting." });
  if (!gameId) return res.status(400).json({ error: "gameId is required." });
  const db = await loadDB();
  if (!db.games.find((g) => g.id === gameId)) return res.status(404).json({ error: "Game not found." });
  const body = String(text || "").trim();
  if (!body) return res.status(400).json({ error: "Message cannot be empty." });
  if (body.length > 500) return res.status(400).json({ error: "Message is too long (max 500 characters)." });
  const msg = { id: id(), gameId, text: body, email, author: nameFromEmail(email), ts: Date.now() };
  db.chat.push(msg);
  const gameMsgs = db.chat.filter((m) => m.gameId === gameId);
  if (gameMsgs.length > CHAT_LIMIT * 3) {
    const keepIds = new Set(gameMsgs.slice(-CHAT_LIMIT * 2).map((m) => m.id));
    db.chat = db.chat.filter((m) => m.gameId !== gameId || keepIds.has(m.id));
  }
  await saveDB(db);
  broadcast("chat", { id: msg.id, gameId });
  res.status(201).json(publicChatMsg(msg));
}));

app.post("/api/chat/mine", h(async (req, res) => {
  const email = auth.verifySession((req.body || {}).sessionToken);
  if (!email) return res.json({ ids: [] });
  const db = await loadDB();
  const ids = db.chat.filter((m) => m.email === email).map((m) => m.id);
  res.json({ ids });
}));

app.delete("/api/chat/:msgId", h(async (req, res) => {
  const db = await loadDB();
  const msg = db.chat.find((m) => m.id === req.params.msgId);
  if (!msg) return res.status(404).json({ error: "Message not found." });
  const isAdmin = req.header("x-admin-key") === ADMIN_KEY;
  const requesterEmail = auth.verifySession((req.body || {}).sessionToken);
  const isOwner = requesterEmail && requesterEmail === msg.email;
  if (!isAdmin && !isOwner) return res.status(403).json({ error: "You can only delete your own messages." });
  db.chat = db.chat.filter((m) => m.id !== req.params.msgId);
  await saveDB(db);
  broadcast("chat", { deleted: req.params.msgId, gameId: msg.gameId });
  res.json({ ok: true });
}));

// ---------- Admin API ----------
app.post("/api/admin/verify", (req, res) => {
  const { key } = req.body || {};
  if (key === ADMIN_KEY) return res.json({ ok: true });
  res.status(401).json({ error: "Invalid admin key." });
});

// ---- Admin: games CRUD ----
app.post("/api/admin/games", requireAdmin, h(async (req, res) => {
  const { name, emoji, description } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Game name is required." });
  const db = await loadDB();
  const game = { id: id(), name: name.trim(), emoji: (emoji || "\uD83C\uDFAE").trim(), description: (description || "").trim(), ts: Date.now() };
  db.games.push(game);
  await saveDB(db);
  broadcast("games", { id: game.id });
  res.status(201).json(game);
}));

app.put("/api/admin/games/:gameId", requireAdmin, h(async (req, res) => {
  const { name, emoji, description } = req.body || {};
  const db = await loadDB();
  const game = db.games.find((g) => g.id === req.params.gameId);
  if (!game) return res.status(404).json({ error: "Game not found." });
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: "Game name cannot be empty." });
    game.name = name.trim();
  }
  if (emoji !== undefined) game.emoji = (emoji || "\uD83C\uDFAE").trim();
  if (description !== undefined) game.description = description.trim();
  await saveDB(db);
  broadcast("games", { id: game.id });
  res.json({ ok: true, game });
}));

app.delete("/api/admin/games/:gameId", requireAdmin, h(async (req, res) => {
  const db = await loadDB();
  const gid = req.params.gameId;
  if (!db.games.find((g) => g.id === gid)) return res.status(404).json({ error: "Game not found." });
  const matchIds = new Set(db.matches.filter((m) => m.gameId === gid).map((m) => m.id));
  db.games = db.games.filter((g) => g.id !== gid);
  db.matches = db.matches.filter((m) => m.gameId !== gid);
  db.bids = db.bids.filter((b) => !matchIds.has(b.matchId));
  db.chat = db.chat.filter((c) => c.gameId !== gid);
  await saveDB(db);
  broadcast("games", { deleted: gid });
  broadcast("matches", {});
  res.json({ ok: true });
}));

app.post("/api/admin/players", requireAdmin, h(async (req, res) => {
  const { name, org } = req.body || {};
  if (!name) return res.status(400).json({ error: "Player name is required." });
  const db = await loadDB();
  const player = { id: id(), name: name.trim(), org: (org || "").trim() };
  db.players.push(player);
  await saveDB(db);
  broadcast("matches", {});
  res.status(201).json(player);
}));

app.delete("/api/admin/players/:playerId", requireAdmin, h(async (req, res) => {
  const db = await loadDB();
  const pid = req.params.playerId;
  const matchIds = new Set(db.matches.filter((m) => m.playerAId === pid || m.playerBId === pid).map((m) => m.id));
  db.players = db.players.filter((p) => p.id !== pid);
  db.matches = db.matches.filter((m) => m.playerAId !== pid && m.playerBId !== pid);
  db.bids = db.bids.filter((b) => !matchIds.has(b.matchId));
  await saveDB(db);
  broadcast("matches", {});
  res.json({ ok: true });
}));

app.post("/api/admin/matches", requireAdmin, h(async (req, res) => {
  const { gameId, playerAId, playerBId, time, day, location, startAt, endAt } = req.body || {};
  if (!gameId) return res.status(400).json({ error: "A game is required." });
  if (!playerAId || !playerBId) return res.status(400).json({ error: "Both players are required." });
  if (playerAId === playerBId) return res.status(400).json({ error: "A match needs two different players." });
  const db = await loadDB();
  if (!db.games.find((g) => g.id === gameId)) return res.status(400).json({ error: "Unknown game." });
  const ids = db.players.map((p) => p.id);
  if (!ids.includes(playerAId) || !ids.includes(playerBId)) return res.status(400).json({ error: "Unknown player(s)." });
  const match = {
    id: id(), gameId, playerAId, playerBId,
    time: (time || "").trim(), day: (day || "Today").trim(), location: (location || "").trim(),
    status: "upcoming", result: null, winnerId: null,
    startAt: parseWhen(startAt), endAt: parseWhen(endAt),
  };
  db.matches.push(match);
  await saveDB(db);
  broadcast("matches", { id: match.id, gameId });
  res.status(201).json(match);
}));

// ---- Admin: bulk match upload (XLSX) ----
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Download a template .xlsx with the expected headers.
app.get("/api/admin/matches/template", (req, res) => {
  const headers = ["game", "playerA", "playerA_org", "playerB", "playerB_org", "time", "day", "location", "startAt"];
  const sample = [{
    game: "Chess", playerA: "Sandeep Singh Sachdeva", playerA_org: "Snapdeal",
    playerB: "Rishi Sharma", playerB_org: "Unicommerce",
    time: "1:30 PM - 2:00 PM", day: "Today", location: "Sky Deck - Tower A",
    startAt: "2026-09-24 13:30",
  }];
  const ws = XLSX.utils.json_to_sheet(sample, { header: headers });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Matches");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Disposition", 'attachment; filename="snapgames-matches-template.xlsx"');
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
});

// Upload matches in bulk. Best-effort: valid rows imported, bad rows skipped
// with a per-row error report. Games/players auto-created by name.
app.post("/api/admin/matches/bulk", requireAdmin, upload.single("file"), h(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded. Attach an .xlsx file as 'file'." });
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  } catch (e) {
    return res.status(400).json({ error: "Could not read the spreadsheet. Is it a valid .xlsx?" });
  }
  if (!rows.length) return res.status(400).json({ error: "The sheet has no data rows." });

  const db = await loadDB();

  // Case-insensitive lookup maps for auto-create-by-name.
  const gameByName = {};
  db.games.forEach((g) => (gameByName[g.name.trim().toLowerCase()] = g));
  const playerByName = {};
  db.players.forEach((p) => (playerByName[p.name.trim().toLowerCase()] = p));

  function ensureGame(name) {
    const key = name.trim().toLowerCase();
    if (gameByName[key]) return gameByName[key];
    const g = { id: id(), name: name.trim(), emoji: "🎮", description: "", ts: Date.now() };
    db.games.push(g);
    gameByName[key] = g;
    return g;
  }
  function ensurePlayer(name, org) {
    const key = name.trim().toLowerCase();
    if (playerByName[key]) {
      if (org && !playerByName[key].org) playerByName[key].org = org.trim();
      return playerByName[key];
    }
    const p = { id: id(), name: name.trim(), org: (org || "").trim() };
    db.players.push(p);
    playerByName[key] = p;
    return p;
  }

  const report = [];
  let created = 0, gamesCreated = 0, playersCreated = 0;
  const gamesBefore = db.games.length, playersBefore = db.players.length;

  rows.forEach((row, i) => {
    const rowNum = i + 2; // + header row, 1-indexed
    const game = String(row.game || "").trim();
    const a = String(row.playerA || "").trim();
    const b = String(row.playerB || "").trim();
    if (!game || !a || !b) {
      report.push({ row: rowNum, ok: false, error: "Missing required game/playerA/playerB." });
      return;
    }
    if (a.toLowerCase() === b.toLowerCase()) {
      report.push({ row: rowNum, ok: false, error: "Player A and B must be different." });
      return;
    }
    const startAt = parseWhen(row.startAt);
    if (row.startAt && startAt == null) {
      report.push({ row: rowNum, ok: false, error: `Unparseable startAt "${row.startAt}" (use YYYY-MM-DD HH:MM).` });
      return;
    }
    const g = ensureGame(game);
    const pa = ensurePlayer(a, row.playerA_org);
    const pb = ensurePlayer(b, row.playerB_org);
    db.matches.push({
      id: id(), gameId: g.id, playerAId: pa.id, playerBId: pb.id,
      time: String(row.time || "").trim(), day: String(row.day || "Today").trim(),
      location: String(row.location || "").trim(),
      status: "upcoming", result: null, winnerId: null,
      startAt, endAt: null,
    });
    created += 1;
    report.push({ row: rowNum, ok: true, match: `${g.name}: ${pa.name} vs ${pb.name}` });
  });

  gamesCreated = db.games.length - gamesBefore;
  playersCreated = db.players.length - playersBefore;

  if (created > 0) {
    await saveDB(db);
    broadcast("matches", {});
    broadcast("games", {});
  }
  res.json({
    ok: true,
    summary: { rows: rows.length, created, skipped: rows.length - created, gamesCreated, playersCreated },
    report,
  });
}));

app.delete("/api/admin/matches/:matchId", requireAdmin, h(async (req, res) => {
  const db = await loadDB();
  const mid = req.params.matchId;
  db.matches = db.matches.filter((m) => m.id !== mid);
  db.bids = db.bids.filter((b) => b.matchId !== mid);
  await saveDB(db);
  broadcast("matches", { deleted: mid });
  res.json({ ok: true });
}));

// Set / update the result of a match (settles bids pari-mutuel).
app.post("/api/admin/matches/:matchId/winner", requireAdmin, h(async (req, res) => {
  const body = req.body || {};
  const result = body.result !== undefined ? body.result : body.winnerId;
  const db = await loadDB();
  const match = db.matches.find((m) => m.id === req.params.matchId);
  if (!match) return res.status(404).json({ error: "Match not found." });
  const val = result || null;
  if (val && val !== "draw" && val !== match.playerAId && val !== match.playerBId) {
    return res.status(400).json({ error: "Result must be one of the two players or a draw." });
  }
  if (isDecided(match)) unsettleMatch(db, match); // reverse before re-applying
  match.result = val;
  match.winnerId = val && val !== "draw" ? val : null;
  if (val) match.status = "finished";
  else if (match.status === "finished") match.status = "upcoming";
  let settlement = null;
  if (val) settlement = settleMatch(db, match);
  await saveDB(db);
  broadcast("winner", { matchId: match.id, result: match.result });
  broadcast("bids", { matchId: match.id, gameId: match.gameId });
  broadcast("matches", { id: match.id });
  res.json({ ok: true, match, settlement });
}));

// Set live/upcoming/over status (does not affect result).
app.post("/api/admin/matches/:matchId/status", requireAdmin, h(async (req, res) => {
  const { status } = req.body || {};
  if (!["upcoming", "live", "over"].includes(status)) {
    return res.status(400).json({ error: "Status must be 'upcoming', 'live', or 'over'." });
  }
  const db = await loadDB();
  const match = db.matches.find((m) => m.id === req.params.matchId);
  if (!match) return res.status(404).json({ error: "Match not found." });
  if (isDecided(match)) {
    return res.status(409).json({ error: "This match is finished (has a result). Clear the result first to change status." });
  }
  const wasLive = match.status === "live";
  match.status = status;
  await saveDB(db);
  broadcast("matches", { id: match.id });
  let notify = null;
  if (status === "live" && !wasLive) {
    const baseUrl = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
    notifyMatchLive(db, match, baseUrl).catch((e) => console.error("[notify] error:", e.message));
    notify = { queued: true, recipients: db.notifyOptIns.length };
  }
  res.json({ ok: true, match, notify });
}));

// ---------- Time-based auto-status scheduler ----------
// Every 20s: flip upcoming->live at startAt (fires notification + closes bids),
// and live->over at endAt. Only acts on matches with the timestamps set and not
// already decided; manual admin actions still take precedence.
const SCHEDULER_INTERVAL_MS = 20 * 1000;
let schedulerRunning = false;

async function runScheduler() {
  if (schedulerRunning) return; // avoid overlap
  schedulerRunning = true;
  try {
    const now = Date.now();
    const db = await loadDB();
    let changed = false;
    const wentLive = [];
    for (const m of db.matches) {
      if (isDecided(m)) continue;
      if (m.status === "upcoming" && m.startAt && now >= m.startAt) {
        m.status = "live";
        changed = true;
        wentLive.push(m);
      } else if (m.status === "live" && m.endAt && now >= m.endAt) {
        m.status = "over";
        changed = true;
      }
    }
    if (changed) {
      await saveDB(db);
      broadcast("matches", {});
      broadcast("games", {});
      // Fire live notifications for matches that just auto-went-live.
      const baseUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
      for (const m of wentLive) {
        broadcast("winner", { matchId: m.id }); // nudge clients (bids closed)
        notifyMatchLive(db, m, baseUrl).catch((e) => console.error("[scheduler notify]", e.message));
        console.log(`[scheduler] match ${m.id} auto -> live`);
      }
    }
  } catch (e) {
    console.error("[scheduler] error:", e.message);
  } finally {
    schedulerRunning = false;
  }
}

// ---------- Startup ----------
(async () => {
  try {
    await seedIfEmpty();
  } catch (e) {
    console.error("[startup] seed/DB error:", e.message);
    console.error("Ensure MySQL is running and schema.sql has been loaded.");
  }
  setInterval(runScheduler, SCHEDULER_INTERVAL_MS);
  runScheduler(); // run once at boot
  app.listen(PORT, () => {
    console.log(`SnapGames server running at http://localhost:${PORT}`);
    console.log(`Admin key: ${ADMIN_KEY}`);
  });
})();
