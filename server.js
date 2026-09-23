const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "acevector2026";
const DATA_FILE = path.join(__dirname, "data", "db.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- Data layer (JSON file store) ----------
function loadDB() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return { players: [], matches: [], votes: [] };
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
        winnerId: null,
      },
      {
        id: id(),
        playerAId: players[2].id,
        playerBId: players[3].id,
        time: "4:30 PM - 5:00 PM",
        day: "Today",
        location: "Sky Deck - Tower A",
        winnerId: null,
      },
    ];
    saveDB({ players, matches, votes: [] });
  }
}
seedIfEmpty();

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

// ---------- Public API ----------

// List players
app.get("/api/players", (req, res) => {
  res.json(loadDB().players);
});

// List matches (enriched with player + vote info)
app.get("/api/matches", (req, res) => {
  const db = loadDB();
  const pm = playerMap(db);
  const matches = db.matches.map((match) => {
    const votesA = db.votes.filter(
      (v) => v.matchId === match.id && v.playerId === match.playerAId
    ).length;
    const votesB = db.votes.filter(
      (v) => v.matchId === match.id && v.playerId === match.playerBId
    ).length;
    return {
      ...match,
      playerA: pm[match.playerAId] || null,
      playerB: pm[match.playerBId] || null,
      winner: match.winnerId ? pm[match.winnerId] || null : null,
      votesA,
      votesB,
    };
  });
  res.json(matches);
});

// Support (vote for) a player in a match. One vote per voter token per match.
app.post("/api/matches/:matchId/support", (req, res) => {
  const { playerId, voterToken } = req.body || {};
  if (!playerId || !voterToken) {
    return res.status(400).json({ error: "playerId and voterToken are required." });
  }
  const db = loadDB();
  const match = db.matches.find((m) => m.id === req.params.matchId);
  if (!match) return res.status(404).json({ error: "Match not found." });
  if (playerId !== match.playerAId && playerId !== match.playerBId) {
    return res.status(400).json({ error: "Player is not part of this match." });
  }

  const existing = db.votes.find(
    (v) => v.matchId === match.id && v.voterToken === voterToken
  );
  if (existing) {
    if (existing.playerId === playerId) {
      return res.status(409).json({ error: "You already supported this player." });
    }
    // switch support to the other player in the same match
    existing.playerId = playerId;
    existing.ts = Date.now();
  } else {
    db.votes.push({
      id: id(),
      matchId: match.id,
      playerId,
      voterToken,
      ts: Date.now(),
    });
  }
  saveDB(db);
  res.json({ ok: true });
});

// Support leaderboard: total support votes per player across all matches
app.get("/api/leaderboard/support", (req, res) => {
  const db = loadDB();
  const pm = playerMap(db);
  const counts = {};
  db.votes.forEach((v) => {
    counts[v.playerId] = (counts[v.playerId] || 0) + 1;
  });
  const board = db.players
    .map((p) => ({ ...p, support: counts[p.id] || 0 }))
    .sort((a, b) => b.support - a.support);
  res.json(board);
});

// Winners leaderboard: matches won per player
app.get("/api/leaderboard/winners", (req, res) => {
  const db = loadDB();
  const wins = {};
  db.matches.forEach((m) => {
    if (m.winnerId) wins[m.winnerId] = (wins[m.winnerId] || 0) + 1;
  });
  const board = db.players
    .map((p) => ({ ...p, wins: wins[p.id] || 0 }))
    .filter((p) => p.wins > 0)
    .sort((a, b) => b.wins - a.wins);
  res.json(board);
});

// ---------- Admin API ----------

// Verify admin key (for login screen)
app.post("/api/admin/verify", (req, res) => {
  const { key } = req.body || {};
  if (key === ADMIN_KEY) return res.json({ ok: true });
  res.status(401).json({ error: "Invalid admin key." });
});

// Add a player
app.post("/api/admin/players", requireAdmin, (req, res) => {
  const { name, org } = req.body || {};
  if (!name) return res.status(400).json({ error: "Player name is required." });
  const db = loadDB();
  const player = { id: id(), name: name.trim(), org: (org || "").trim() };
  db.players.push(player);
  saveDB(db);
  res.status(201).json(player);
});

// Delete a player (and their votes / clear from matches)
app.delete("/api/admin/players/:playerId", requireAdmin, (req, res) => {
  const db = loadDB();
  const pid = req.params.playerId;
  db.players = db.players.filter((p) => p.id !== pid);
  db.votes = db.votes.filter((v) => v.playerId !== pid);
  db.matches = db.matches.filter(
    (m) => m.playerAId !== pid && m.playerBId !== pid
  );
  saveDB(db);
  res.json({ ok: true });
});

// Add a match
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
    winnerId: null,
  };
  db.matches.push(match);
  saveDB(db);
  res.status(201).json(match);
});

// Delete a match (and its votes)
app.delete("/api/admin/matches/:matchId", requireAdmin, (req, res) => {
  const db = loadDB();
  const mid = req.params.matchId;
  db.matches = db.matches.filter((m) => m.id !== mid);
  db.votes = db.votes.filter((v) => v.matchId !== mid);
  saveDB(db);
  res.json({ ok: true });
});

// Mark / update the winner of a match
app.post("/api/admin/matches/:matchId/winner", requireAdmin, (req, res) => {
  const { winnerId } = req.body || {};
  const db = loadDB();
  const match = db.matches.find((m) => m.id === req.params.matchId);
  if (!match) return res.status(404).json({ error: "Match not found." });
  if (winnerId && winnerId !== match.playerAId && winnerId !== match.playerBId) {
    return res.status(400).json({ error: "Winner must be one of the two players." });
  }
  match.winnerId = winnerId || null;
  saveDB(db);
  res.json({ ok: true, match });
});

app.listen(PORT, () => {
  console.log(`CHECKMATE server running at http://localhost:${PORT}`);
  console.log(`Admin key: ${ADMIN_KEY}`);
});
