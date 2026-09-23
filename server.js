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
    db.players = db.players || [];
    db.matches = db.matches || [];
    db.predictions = db.predictions || db.votes || []; // migrate old "votes"
    db.posts = db.posts || [];
    delete db.votes;
    return db;
  } catch (e) {
    return { players: [], matches: [], predictions: [], posts: [] };
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
  if (db.players.length === 0 && db.matches.length === 0) {
    const players = [
      { id: id(), name: "Sandeep Singh Sachdeva", org: "Snapdeal" },
      { id: id(), name: "Rishi Sharma", org: "Unicommerce" },
      { id: id(), name: "Anshuman Sengar", org: "Unicommerce" },
      { id: id(), name: "Sarthak", org: "Snapdeal" },
    ];
    const matches = [
      {
        id: id(),
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
    saveDB({ players, matches, predictions: [], posts: [] });
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
// status ("live" or "upcoming"), defaulting to "upcoming".
function effectiveStatus(match) {
  if (isDecided(match)) return "finished";
  return match.status === "live" ? "live" : "upcoming";
}

// List matches enriched with prediction counts + result
app.get("/api/matches", (req, res) => {
  const db = loadDB();
  const pm = playerMap(db);
  const matches = db.matches.map((match) => {
    const votesA = db.predictions.filter(
      (v) => v.matchId === match.id && v.playerId === match.playerAId
    ).length;
    const votesB = db.predictions.filter(
      (v) => v.matchId === match.id && v.playerId === match.playerBId
    ).length;
    const votesDraw = db.predictions.filter(
      (v) => v.matchId === match.id && v.playerId === "draw"
    ).length;
    const result = matchResult(match);
    return {
      ...match,
      result,
      isDraw: result === "draw",
      playerA: pm[match.playerAId] || null,
      playerB: pm[match.playerBId] || null,
      winner:
        result && result !== "draw" ? pm[result] || null : null,
      status: effectiveStatus(match),
      votesA,
      votesB,
      votesDraw,
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

// ---- Predictions ----
// Predict the outcome of a match: a player, or "draw".
// One prediction per verified EMAIL per match.
app.post("/api/matches/:matchId/predict", (req, res) => {
  const { playerId, sessionToken } = req.body || {};
  const email = auth.verifySession(sessionToken);
  if (!email) {
    return res
      .status(401)
      .json({ error: "Please verify your email before making a prediction." });
  }
  if (!playerId) {
    return res.status(400).json({ error: "A prediction is required." });
  }
  const db = loadDB();
  const match = db.matches.find((m) => m.id === req.params.matchId);
  if (!match) return res.status(404).json({ error: "Match not found." });
  const isValidPick =
    playerId === "draw" ||
    playerId === match.playerAId ||
    playerId === match.playerBId;
  if (!isValidPick) {
    return res.status(400).json({ error: "Invalid prediction for this match." });
  }
  if (isDecided(match)) {
    return res.status(409).json({ error: "This match is over — predictions are closed." });
  }

  const existing = db.predictions.find(
    (v) => v.matchId === match.id && v.email === email
  );
  if (existing) {
    if (existing.playerId === playerId) {
      return res.status(409).json({ error: "You already made this prediction." });
    }
    existing.playerId = playerId;
    existing.ts = Date.now();
  } else {
    db.predictions.push({
      id: id(),
      matchId: match.id,
      playerId,
      email,
      ts: Date.now(),
    });
  }
  saveDB(db);
  broadcast("predictions", { matchId: match.id });
  res.json({ ok: true });
});

// Return the verified user's own predictions: { matchId: playerId }
// Lets the UI correctly show "already predicted" even after re-login / incognito.
app.post("/api/my-predictions", (req, res) => {
  const email = auth.verifySession((req.body || {}).sessionToken);
  if (!email) return res.json({}); // not verified -> no predictions to show
  const db = loadDB();
  const mine = {};
  db.predictions
    .filter((v) => v.email === email)
    .forEach((v) => (mine[v.matchId] = v.playerId));
  res.json(mine);
});

// Player prediction leaderboard: total predictions received per player
app.get("/api/leaderboard/predictions", (req, res) => {
  const db = loadDB();
  const counts = {};
  db.predictions.forEach((v) => {
    counts[v.playerId] = (counts[v.playerId] || 0) + 1;
  });
  const board = db.players
    .map((p) => ({ ...p, predictions: counts[p.id] || 0 }))
    .sort((a, b) => b.predictions - a.predictions);
  res.json(board);
});

// Predictor accuracy leaderboard: which people predicted the result correctly
// (predicting "draw" counts as correct when the match is drawn).
app.get("/api/leaderboard/predictors", (req, res) => {
  const db = loadDB();
  const decided = {}; // matchId -> result ("draw" | playerId), only decided matches
  db.matches.forEach((m) => {
    const r = matchResult(m);
    if (r) decided[m.id] = r;
  });

  const byEmail = {}; // email -> { correct, total }
  db.predictions.forEach((v) => {
    if (!(v.matchId in decided)) return; // only score decided matches
    const e = v.email;
    byEmail[e] = byEmail[e] || { correct: 0, total: 0 };
    byEmail[e].total += 1;
    if (decided[v.matchId] === v.playerId) byEmail[e].correct += 1; // exact match incl. "draw"
  });

  const board = Object.entries(byEmail)
    .map(([email, s]) => ({
      email,
      name: nameFromEmail(email),
      correct: s.correct,
      total: s.total,
      accuracy: s.total ? Math.round((s.correct / s.total) * 100) : 0,
    }))
    .sort((a, b) => b.correct - a.correct || b.accuracy - a.accuracy);
  res.json(board);
});

// Player standings (chess points): win = 1.0, draw = 0.5 each.
app.get("/api/leaderboard/winners", (req, res) => {
  const db = loadDB();
  const stats = {}; // playerId -> { wins, draws, points }
  function ensure(pid) {
    stats[pid] = stats[pid] || { wins: 0, draws: 0, points: 0 };
    return stats[pid];
  }
  db.matches.forEach((m) => {
    const r = matchResult(m);
    if (!r) return;
    if (r === "draw") {
      ensure(m.playerAId).draws += 1;
      ensure(m.playerAId).points += 0.5;
      ensure(m.playerBId).draws += 1;
      ensure(m.playerBId).points += 0.5;
    } else {
      ensure(r).wins += 1;
      ensure(r).points += 1;
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

// ---------- Admin API ----------
app.post("/api/admin/verify", (req, res) => {
  const { key } = req.body || {};
  if (key === ADMIN_KEY) return res.json({ ok: true });
  res.status(401).json({ error: "Invalid admin key." });
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
  const { playerAId, playerBId, time, day, location } = req.body || {};
  if (!playerAId || !playerBId) {
    return res.status(400).json({ error: "Both players are required." });
  }
  if (playerAId === playerBId) {
    return res.status(400).json({ error: "A match needs two different players." });
  }
  const db = loadDB();
  const ids = db.players.map((p) => p.id);
  if (!ids.includes(playerAId) || !ids.includes(playerBId)) {
    return res.status(400).json({ error: "Unknown player(s)." });
  }
  const match = {
    id: id(),
    playerAId,
    playerBId,
    time: (time || "").trim(),
    day: (day || "Today").trim(),
    location: (location || "Sky Deck - Tower A").trim(),
    status: "upcoming",
    result: null,
    winnerId: null,
  };
  db.matches.push(match);
  saveDB(db);
  broadcast("matches", { id: match.id });
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

  match.result = val; // "draw" | playerId | null
  match.winnerId = val && val !== "draw" ? val : null; // keep legacy field in sync
  // Setting a result finishes the match; clearing it reverts to upcoming.
  if (val) match.status = "finished";
  else if (match.status === "finished") match.status = "upcoming";
  saveDB(db);
  broadcast("winner", { matchId: match.id, result: match.result });
  broadcast("matches", { id: match.id });
  res.json({ ok: true, match });
});

// Set the live/upcoming status of a match (does not affect the result).
app.post("/api/admin/matches/:matchId/status", requireAdmin, (req, res) => {
  const { status } = req.body || {};
  if (!["upcoming", "live"].includes(status)) {
    return res.status(400).json({ error: "Status must be 'upcoming' or 'live'." });
  }
  const db = loadDB();
  const match = db.matches.find((m) => m.id === req.params.matchId);
  if (!match) return res.status(404).json({ error: "Match not found." });
  if (isDecided(match)) {
    return res
      .status(409)
      .json({ error: "This match is finished (has a result). Clear the result first to change status." });
  }
  match.status = status;
  saveDB(db);
  broadcast("matches", { id: match.id });
  res.json({ ok: true, match });
});

app.listen(PORT, () => {
  console.log(`CHECKMATE server running at http://localhost:${PORT}`);
  console.log(`Admin key: ${ADMIN_KEY}`);
});
