require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
const XLSX = require("xlsx");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const auth = require("./auth");

const app = express();
// Disable ETag for API responses; combined with no-store below this guarantees
// the client always gets fresh data (no stale-until-refresh on admin actions).
app.set("etag", false);
const PORT = process.env.PORT || 3000;

// Behind Render/Nginx/ALB the real client IP is in X-Forwarded-For. Trust the
// proxy so rate limiting keys on the actual client, not the proxy IP.
// TRUST_PROXY defaults to 1 (one proxy hop, correct for Render).
app.set("trust proxy", Number(process.env.TRUST_PROXY || 1));

const ADMIN_KEY = process.env.ADMIN_KEY;
if (!ADMIN_KEY) {
  console.error("[fatal] ADMIN_KEY is not set. Refusing to start without an admin key.");
  console.error("Set it in .env (local) or your host's environment: ADMIN_KEY=your-secret");
  process.exit(1);
}
const STARTING_BALANCE = Number(process.env.STARTING_BALANCE || 10000);
// MAX_BID = 0 (or unset) means no cap — a user may bid up to their balance.
const MAX_BID = Number(process.env.MAX_BID || 0);

// ---------- Security headers (helmet) ----------
// The frontend uses inline <script>, inline onclick handlers, inline styles,
// and a data: URI (select arrow). CSP therefore allows 'unsafe-inline' for
// script/style and data: images. No external origins are used.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false, // set directives explicitly so helmet doesn't add
                        // script-src-attr 'none' (which blocks inline onclick)
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"], // the app uses inline onclick handlers
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],     // SSE (/api/events) is same-origin
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"], // clickjacking protection
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false, // avoid breaking SSE/simple embeds
}));

// ---------- Rate limiting ----------
const rlOpts = { standardHeaders: true, legacyHeaders: false };
// Global: generous cap to stop floods without hurting normal use.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, max: 300,
  message: { error: "Too many requests — please slow down." },
  ...rlOpts,
});
// OTP send: expensive (sends email) — strict.
const otpLimiter = rateLimit({
  windowMs: 60 * 1000, max: 5,
  message: { error: "Too many code requests. Wait a minute and try again." },
  ...rlOpts,
});
// Writes (bid / post / chat): moderate per-IP cap against spam.
const writeLimiter = rateLimit({
  windowMs: 60 * 1000, max: 40,
  message: { error: "You're doing that too fast — slow down." },
  ...rlOpts,
});
// SSE connection opens: cap new stream connections per IP.
const sseLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  message: "rate limited",
  ...rlOpts,
});

app.use(globalLimiter);

// Parse JSON for everything EXCEPT multipart/form-data (file uploads), which
// multer handles per-route. type:() => true otherwise parses even when the
// client sends a wrong/missing Content-Type.
app.use(express.json({
  type: (req) => !String(req.headers["content-type"] || "").includes("multipart/form-data"),
  limit: "100kb",
}));
// Request logger FIRST (before express.static) so it also times static assets
// (HTML/JS/CSS) — previously those were served above the logger and invisible,
// which is exactly where an intermittent stall could hide. To keep the log
// readable we print every dynamic /api/ request, plus ANY request slower than
// 500ms (including static), and flag >800ms as [SLOW] with a wall-clock time
// so stalls can be correlated with when they're experienced.
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const isApi = req.path.startsWith("/api/");
    if (isApi || ms > 500) {
      const flag = ms > 800 ? " [SLOW]" : "";
      console.log(
        `[req ${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)${flag}`
      );
    }
  });
  next();
});

// Dynamic API responses must never be cached by the browser.
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

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
  // Managed/free MySQL hosts (TiDB Cloud, Aiven, etc.) require TLS. Enable with
  // DB_SSL=true. Providers whose cert chains to a public CA (e.g. TiDB Cloud)
  // need no cert file; for a private CA, pass the PEM in DB_CA.
  ssl:
    process.env.DB_SSL === "true"
      ? {
          minVersion: "TLSv1.2",
          rejectUnauthorized: true,
          ...(process.env.DB_CA ? { ca: process.env.DB_CA } : {}),
        }
      : undefined,
});

// Diagnostic: show what DB the app actually resolved (never logs the password).
console.log(
  `[db] host=${process.env.DB_HOST || "localhost"} port=${Number(
    process.env.DB_PORT || 3306
  )} user=${process.env.DB_USER || "root"} database=${
    process.env.DB_NAME || "checkmate"
  } ssl=${process.env.DB_SSL === "true"}`
);
// Confirm which schema the connection lands in (TiDB defaults to `sys` if
// DB_NAME is unset/wrong). This tells us the real DEFAULT database.
pool
  .query("SELECT DATABASE() AS db, CURRENT_USER() AS who")
  .then(([rows]) =>
    console.log(`[db] connected default_database=${rows[0].db} as=${rows[0].who}`)
  )
  .catch((e) => console.error("[db] probe failed:", e.message));

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
  const [users] = await pool.query("SELECT * FROM users");
  const [tournaments] = await pool.query("SELECT * FROM tournaments");
  const [registrations] = await pool.query("SELECT * FROM tournament_registrations");

  // Normalize MySQL tinyint(1) to boolean for posts / bids.
  posts.forEach((p) => (p.anonymous = !!p.anonymous));
  bids.forEach((b) => (b.settled = !!b.settled));
  // orgs is stored as a comma-separated string; expose it as an array.
  tournaments.forEach((t) => {
    t.orgs = String(t.orgs || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  });

  const wallets = {};
  walletRows.forEach((w) => (wallets[w.email] = w.balance));

  return {
    games, players, matches, bids, wallets, posts, chat,
    notifyOptIns: optins.map((o) => o.email),
    users, tournaments, registrations,
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
    await conn.query("DELETE FROM tournament_registrations");
    await conn.query("DELETE FROM tournaments");
    await conn.query("DELETE FROM users");

    for (const g of db.games) {
      await conn.query(
        "INSERT INTO games (id, name, emoji, description, ts) VALUES (?, ?, ?, ?, ?)",
        [g.id, g.name, g.emoji || "🎮", g.description || "", g.ts || Date.now()]
      );
    }
    for (const p of db.players) {
      await conn.query("INSERT INTO players (id, name, org, email) VALUES (?, ?, ?, ?)", [
        p.id, p.name, p.org || "", p.email || null,
      ]);
    }
    for (const m of db.matches) {
      await conn.query(
        `INSERT INTO matches (id, gameId, tournamentId, playerAId, playerBId, time, day, location, status, result, winnerId, startAt, endAt, resultEmailedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [m.id, m.gameId, m.tournamentId || null, m.playerAId, m.playerBId, m.time || "", m.day || "Today",
         m.location || "", m.status || "upcoming", m.result || null, m.winnerId || null,
         m.startAt != null ? m.startAt : null, m.endAt != null ? m.endAt : null,
         m.resultEmailedAt != null ? m.resultEmailedAt : null]
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
    for (const u of db.users || []) {
      await conn.query(
        "INSERT INTO users (email, name, createdAt) VALUES (?, ?, ?)",
        [u.email, u.name, u.createdAt || Date.now()]
      );
    }
    for (const t of db.tournaments || []) {
      const orgsStr = Array.isArray(t.orgs) ? t.orgs.join(",") : String(t.orgs || "");
      await conn.query(
        `INSERT INTO tournaments (id, name, gameType, regStart, regEnd, status, orgs, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [t.id, t.name, t.gameType || "", t.regStart != null ? t.regStart : null,
         t.regEnd != null ? t.regEnd : null, t.status || "active", orgsStr, t.createdAt || Date.now()]
      );
    }
    for (const r of db.registrations || []) {
      await conn.query(
        `INSERT INTO tournament_registrations (tournamentId, email, registeredAt, gamesWon, position)
         VALUES (?, ?, ?, ?, ?)`,
        [r.tournamentId, r.email, r.registeredAt || Date.now(),
         r.gamesWon || 0, r.position != null ? r.position : null]
      );
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ponytail: global in-process write lock. Every mutation here is a
// load-all -> mutate-in-JS -> save-all sequence; without serialization two
// concurrent writers (e.g. two people bidding on a live match at once, or a
// bid landing while the scheduler fires) both start from the same snapshot and
// the last save silently clobbers the other's change — including wallet
// balances. mutateDB() runs load+mutate+save under a single promise chain so
// those sequences can't interleave. Ceiling: single process only. If this ever
// runs multi-instance or under real load, move to per-row SQL + transactions
// with SELECT ... FOR UPDATE on the wallet row.
let writeChain = Promise.resolve();
function mutateDB(fn) {
  const run = writeChain.then(async () => {
    const db = await loadDB();
    // Default: assume the callback mutated `db` and needs persisting. A callback
    // that early-returns without changing anything can call ctx.markClean() to
    // skip the (expensive) full-dataset rewrite in saveDB.
    let dirty = true;
    const result = await fn(db, { markClean: () => { dirty = false; } });
    if (dirty) await saveDB(db);
    return result;
  });
  // Keep the chain alive even if this mutation throws.
  writeChain = run.then(() => {}, () => {});
  return run;
}

// ---- Allowed orgs/domains config (DB-backed, admin-managed) ----
// Create the config tables if they don't exist (so no manual migration is
// needed on an existing DB).
// Does a column exist on a table in the current database?
async function columnExists(table, column) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}
async function addColumnIfMissing(table, column, ddl) {
  if (!(await columnExists(table, column))) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`[schema] added column ${table}.${column}`);
  }
}

// Idempotent auto-migration run at every boot. Creates any missing tables and
// adds any missing columns, so deploying the new code onto an existing database
// upgrades it in place — no manual migration step needed. Requires the DB user
// to have CREATE/ALTER privileges (managed MySQL app users normally do).
async function ensureSchema() {
  // Core tables (mirror schema.sql) — makes the app self-provisioning on a
  // fresh or partial database, with no need to run schema.sql by hand.
  await pool.query(
    `CREATE TABLE IF NOT EXISTS games (
       id VARCHAR(32) PRIMARY KEY, name VARCHAR(255) NOT NULL, emoji VARCHAR(16) DEFAULT '🎮',
       description VARCHAR(500) DEFAULT '', ts BIGINT NOT NULL
     )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS players (
       id VARCHAR(32) PRIMARY KEY, name VARCHAR(255) NOT NULL,
       org VARCHAR(255) DEFAULT '', email VARCHAR(255) DEFAULT NULL
     )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS matches (
       id VARCHAR(32) PRIMARY KEY, gameId VARCHAR(32) NOT NULL, tournamentId VARCHAR(32) DEFAULT NULL,
       playerAId VARCHAR(32) NOT NULL, playerBId VARCHAR(32) NOT NULL, time VARCHAR(255) DEFAULT '',
       day VARCHAR(64) DEFAULT 'Today', location VARCHAR(255) DEFAULT '', status VARCHAR(16) DEFAULT 'upcoming',
       result VARCHAR(32) DEFAULT NULL, winnerId VARCHAR(32) DEFAULT NULL,
       startAt BIGINT DEFAULT NULL, endAt BIGINT DEFAULT NULL
     )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS bids (
       id VARCHAR(32) PRIMARY KEY, matchId VARCHAR(32) NOT NULL, gameId VARCHAR(32) NOT NULL,
       email VARCHAR(255) NOT NULL, outcome VARCHAR(8) NOT NULL, stake INT NOT NULL, ts BIGINT NOT NULL,
       settled TINYINT(1) NOT NULL DEFAULT 0, payout INT NOT NULL DEFAULT 0,
       UNIQUE KEY uniq_match_email (matchId, email)
     )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS wallets (email VARCHAR(255) PRIMARY KEY, balance INT NOT NULL DEFAULT 1000)`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS posts (
       id VARCHAR(32) PRIMARY KEY, text VARCHAR(500) NOT NULL, email VARCHAR(255) NOT NULL,
       author VARCHAR(255) NOT NULL, anonymous TINYINT(1) DEFAULT 0, ts BIGINT NOT NULL,
       status VARCHAR(16) DEFAULT 'pending'
     )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS chat (
       id VARCHAR(32) PRIMARY KEY, gameId VARCHAR(32) NOT NULL, text VARCHAR(500) NOT NULL,
       email VARCHAR(255) NOT NULL, author VARCHAR(255) NOT NULL, ts BIGINT NOT NULL
     )`
  );
  await pool.query("CREATE TABLE IF NOT EXISTS notify_optins (email VARCHAR(255) PRIMARY KEY)");

  // Feature tables (safe to run repeatedly).
  await pool.query(
    `CREATE TABLE IF NOT EXISTS users (
       email VARCHAR(255) PRIMARY KEY, name VARCHAR(255) NOT NULL, createdAt BIGINT NOT NULL
     )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS tournaments (
       id VARCHAR(32) PRIMARY KEY, name VARCHAR(255) NOT NULL,
       gameType VARCHAR(255) NOT NULL DEFAULT '', regStart BIGINT DEFAULT NULL,
       regEnd BIGINT DEFAULT NULL, status VARCHAR(16) NOT NULL DEFAULT 'active',
       orgs VARCHAR(500) NOT NULL DEFAULT '', createdAt BIGINT NOT NULL
     )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS tournament_registrations (
       tournamentId VARCHAR(32) NOT NULL, email VARCHAR(255) NOT NULL,
       registeredAt BIGINT NOT NULL, gamesWon INT NOT NULL DEFAULT 0,
       position INT DEFAULT NULL, PRIMARY KEY (tournamentId, email)
     )`
  );
  await pool.query("CREATE TABLE IF NOT EXISTS allowed_domains (domain VARCHAR(255) PRIMARY KEY)");
  await pool.query("CREATE TABLE IF NOT EXISTS app_meta (k VARCHAR(64) PRIMARY KEY, v TEXT)");

  // New columns on pre-existing tables (MySQL has no portable ADD COLUMN IF
  // NOT EXISTS, so we check information_schema first).
  await addColumnIfMissing("players", "email", "email VARCHAR(255) DEFAULT NULL");
  await addColumnIfMissing("matches", "tournamentId", "tournamentId VARCHAR(32) DEFAULT NULL");
  await addColumnIfMissing("tournaments", "orgs", "orgs VARCHAR(500) NOT NULL DEFAULT ''");
}
async function getMeta(k) {
  const [rows] = await pool.query("SELECT v FROM app_meta WHERE k = ?", [k]);
  return rows.length ? rows[0].v : null;
}
async function setMeta(k, v) {
  await pool.query(
    "INSERT INTO app_meta (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)",
    [k, v]
  );
}
async function loadAllowedDomains() {
  const [rows] = await pool.query("SELECT domain FROM allowed_domains ORDER BY domain");
  return rows.map((r) => r.domain);
}
// Push the DB list into the auth layer so registration checks use it live.
async function refreshAllowedDomains() {
  const domains = await loadAllowedDomains();
  auth.setAllowedDomains(domains);
  return domains;
}
// One-time seed from ALLOWED_EMAIL_DOMAINS so existing config carries over.
// After this the admin fully owns the list (including clearing it = any domain).
async function seedAllowedDomainsOnce() {
  if (await getMeta("orgs_seeded")) return;
  const envDomains = (process.env.ALLOWED_EMAIL_DOMAINS || "")
    .split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  for (const d of envDomains) {
    await pool.query("INSERT IGNORE INTO allowed_domains (domain) VALUES (?)", [d]);
  }
  await setMeta("orgs_seeded", "1");
  console.log(`[config] seeded allowed domains from env: ${envDomains.join(", ") || "(none)"}`);
}
// Shape a domain into { domain, org, name } for the admin UI.
function domainToOrg(d) {
  const org = (String(d).split(".")[0] || "").toLowerCase();
  return { domain: d, org, name: org ? org.charAt(0).toUpperCase() + org.slice(1) : d };
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
// Cap concurrent SSE streams per IP to prevent connection/memory exhaustion.
const sseByIp = new Map(); // ip -> count
const MAX_SSE_PER_IP = Number(process.env.MAX_SSE_PER_IP || 5);

app.get("/api/events", sseLimiter, (req, res) => {
  const ip = req.ip;
  const cur = sseByIp.get(ip) || 0;
  if (cur >= MAX_SSE_PER_IP) {
    return res.status(429).end("Too many live connections from your network.");
  }
  sseByIp.set(ip, cur + 1);

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  sseClients.add(res);
  console.log(`[sse] client connected (open=${sseClients.size}) from ${req.ip}`);
  const ping = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { /* ignore */ }
  }, 25000);
  req.on("close", () => {
    clearInterval(ping);
    sseClients.delete(res);
    const n = (sseByIp.get(ip) || 1) - 1;
    if (n <= 0) sseByIp.delete(ip); else sseByIp.set(ip, n);
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
    console.error(`[error] ${req.method} ${req.originalUrl}:`, e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error." });
  });
}

// ---------- Helpers ----------
function requireAdmin(req, res, next) {
  const key = req.header("x-admin-key") || "";
  // Constant-time compare to avoid leaking the key length/prefix via timing.
  const a = Buffer.from(key);
  const b = Buffer.from(ADMIN_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.warn(`[admin] denied ${req.method} ${req.originalUrl} from ${req.ip}`);
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

// Email each bidder their win/loss result. Throttled (concurrency 3),
// fire-and-forget. `results` = [{ to, won, stake, payout, balance, matchLine, outcomeLabel }]
async function sendBetResultEmails(results) {
  const url = (process.env.PUBLIC_URL || "").replace(/\/$/, "") || undefined;
  const CONCURRENCY = 3;
  let i = 0, sent = 0, failed = 0;
  async function worker() {
    while (i < results.length) {
      const r = results[i++];
      const out = await auth.sendBetResultEmail(r.to, { ...r, url });
      if (out.ok) sent++; else failed++;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`[bet-result] emailed ${sent}/${results.length} bidders (failed ${failed})`);
  return { sent, failed, total: results.length };
}

function nameFromEmail(email) {
  const local = String(email || "").split("@")[0];
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") || email;
}

// Title-cased org label derived from the email domain (unicommerce -> Unicommerce).
function orgName(email) {
  const org = auth.orgFromEmail(email);
  return org ? org.charAt(0).toUpperCase() + org.slice(1) : "";
}

// ---- User profile helpers ----
// Ensure a users row exists for this email; returns the user object. Name
// defaults to the title-cased email local part (same as nameFromEmail).
function ensureUser(db, email) {
  if (!db.users) db.users = [];
  let u = db.users.find((x) => x.email === email);
  if (!u) {
    u = { email, name: nameFromEmail(email), createdAt: Date.now() };
    db.users.push(u);
  }
  return u;
}

function displayName(db, email) {
  const u = (db.users || []).find((x) => x.email === email);
  return (u && u.name) || nameFromEmail(email);
}

// Ensure a roster entry (player) exists for a user email; returns it.
function ensurePlayerForUser(db, email) {
  if (!db.players) db.players = [];
  let p = db.players.find((x) => x.email === email);
  if (!p) {
    const u = (db.users || []).find((x) => x.email === email);
    p = { id: id(), name: (u && u.name) || nameFromEmail(email), org: "", email };
    db.players.push(p);
  }
  return p;
}

// Ensure a backing "game" exists for a tournament (shared id) so matches,
// betting, chat and leaderboards — all scoped by gameId — keep working while
// matches are organised under a tournament.
function ensureGameForTournament(db, t) {
  if (!db.games) db.games = [];
  let g = db.games.find((x) => x.id === t.id);
  if (!g) {
    g = {
      id: t.id,
      name: t.gameType ? `${t.gameType} — ${t.name}` : t.name,
      emoji: "🏆",
      description: t.name,
      ts: t.createdAt || Date.now(),
    };
    db.games.push(g);
  }
  return g;
}

// ---- Tournament helpers ----
// Registration window state for a tournament, given "now".
function regState(t, now = Date.now()) {
  const start = t.regStart != null ? t.regStart : null;
  const end = t.regEnd != null ? t.regEnd : null;
  if (start != null && now < start) return "upcoming"; // registration not open yet
  if (end != null && now > end) return "closed";        // registration window passed
  return "open";                                        // within window (or no bounds set)
}
function regOpen(t, now = Date.now()) { return regState(t, now) === "open"; }

// Normalize a requested org list against the allowed orgs. Returns a clean
// array (subset of allowed); empty array means "all orgs".
function sanitizeOrgs(orgs) {
  const allowed = new Set(auth.allowedOrgs());
  if (!Array.isArray(orgs)) return [];
  const clean = orgs
    .map((o) => String(o || "").trim().toLowerCase())
    .filter((o) => o && (allowed.size === 0 || allowed.has(o)));
  return [...new Set(clean)];
}

// Is a user (by email) eligible to register for this tournament's org scope?
function orgEligible(t, email) {
  const orgs = Array.isArray(t.orgs) ? t.orgs : [];
  if (orgs.length === 0) return true; // open to all orgs
  return orgs.includes(auth.orgFromEmail(email));
}

// Build the public shape of a tournament, including participant count and,
// optionally, whether a given email is registered.
function tournamentSummary(db, t, forEmail) {
  const regs = (db.registrations || []).filter((r) => r.tournamentId === t.id);
  const orgs = Array.isArray(t.orgs) ? t.orgs : [];
  const orgsLabel = orgs.length
    ? orgs.map((o) => o.charAt(0).toUpperCase() + o.slice(1)).join(", ")
    : "All orgs";
  return {
    id: t.id,
    name: t.name,
    gameType: t.gameType || "",
    regStart: t.regStart != null ? t.regStart : null,
    regEnd: t.regEnd != null ? t.regEnd : null,
    status: t.status || "active",
    orgs,
    orgsLabel,
    createdAt: t.createdAt || 0,
    registrationState: regState(t),
    registrationOpen: regOpen(t),
    participantCount: regs.length,
    registered: forEmail ? regs.some((r) => r.email === forEmail) : undefined,
    eligible: forEmail ? orgEligible(t, forEmail) : undefined,
  };
}

// Build a public profile for an email: name, tournaments participated (with
// per-tournament position + games won) and aggregate stats.
function buildProfile(db, email) {
  const name = displayName(db, email);
  const regs = (db.registrations || []).filter((r) => r.email === email);
  const tById = {};
  (db.tournaments || []).forEach((t) => (tById[t.id] = t));
  const tournaments = regs
    .map((r) => {
      const t = tById[r.tournamentId];
      if (!t) return null;
      return {
        id: t.id,
        name: t.name,
        gameType: t.gameType || "",
        registeredAt: r.registeredAt || 0,
        gamesWon: r.gamesWon || 0,
        position: r.position != null ? r.position : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.registeredAt - a.registeredAt);
  const totalGamesWon = tournaments.reduce((s, t) => s + (t.gamesWon || 0), 0);
  const podiums = tournaments.filter((t) => t.position != null && t.position <= 3).length;

  // Games played/won come from decided matches involving any roster entry
  // (player) linked to this user's email.
  const myPlayerIds = new Set(
    (db.players || []).filter((p) => p.email === email).map((p) => p.id)
  );
  let gamesPlayed = 0, gamesWon = 0, gamesDrawn = 0;
  (db.matches || []).forEach((m) => {
    const inMatch = myPlayerIds.has(m.playerAId) || myPlayerIds.has(m.playerBId);
    if (!inMatch) return;
    const r = matchResult(m);
    if (!r) return; // only count decided matches
    gamesPlayed += 1;
    if (r === "draw") gamesDrawn += 1;
    else if (myPlayerIds.has(r)) gamesWon += 1;
  });

  return {
    email,
    name,
    org: auth.orgFromEmail(email),
    orgName: orgName(email),
    tournamentsParticipated: tournaments.length,
    totalGamesWon,
    podiums,
    tournaments,
    gamesPlayed,
    gamesWon,
    gamesDrawn,
  };
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

// Central client config: the allowed orgs (derived from ALLOWED_EMAIL_DOMAINS).
// Drives the registration hint and the admin's per-org tournament scoping.
app.get("/api/config", h(async (req, res) => {
  res.json({
    allowedOrgs: auth.allowedOrgs().map((o) => ({
      id: o, name: o.charAt(0).toUpperCase() + o.slice(1),
    })),
  });
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
app.post("/api/auth/request-otp", otpLimiter, h(async (req, res) => {
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
    optedIn = await mutateDB(async (db) => {
      addOptIn(db, result.email);
      getBalance(db, result.email); // ensure a wallet exists on first login
      ensureUser(db, result.email); // ensure a profile exists on first login
      return isOptedIn(db, result.email);
    });
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
  // Read-only: this is polled on every page load (nav balance chip), so it must
  // NOT go through mutateDB (a full DB rewrite under the global write lock).
  // The wallet row is created at verify-otp time; if it's somehow missing we
  // just report the starting balance without persisting.
  const db = await loadDB();
  const balance = db.wallets[email] !== undefined ? db.wallets[email] : STARTING_BALANCE;
  res.json({ verified: true, email, balance });
}));

// Place a bid on a match. Body: { outcome: "A"|"B"|"draw", stake: 1..MAX_BID, sessionToken }
// One bid per user per match, only while Upcoming. Deducts stake from wallet.
app.post("/api/matches/:matchId/bid", writeLimiter, h(async (req, res) => {
  const { outcome, stake, sessionToken } = req.body || {};
  const email = auth.verifySession(sessionToken);
  if (!email) return res.status(401).json({ error: "Please verify your email before bidding." });
  if (!["A", "B", "draw"].includes(outcome)) {
    return res.status(400).json({ error: "Choose Player A, Player B, or Draw." });
  }
  // Stake must be a positive whole number. Reject floats, NaN, Infinity, and
  // unsafe/huge integers outright (don't silently floor a bad value).
  const amt = Number(stake);
  if (!Number.isInteger(amt) || !Number.isSafeInteger(amt) || amt < 1) {
    return res.status(400).json({ error: "Bid must be a whole number of at least ₹1." });
  }
  if (MAX_BID > 0 && amt > MAX_BID) {
    return res.status(400).json({ error: `Bid cannot exceed ₹${MAX_BID}.` });
  }
  // Mutate first, then respond/broadcast only AFTER the write is committed, so
  // a failed saveDB never leaves the client thinking the bid succeeded.
  const out = await mutateDB(async (db, { markClean }) => {
    const match = db.matches.find((m) => m.id === req.params.matchId);
    if (!match) {
      markClean();
      return { status: 404, body: { error: "Match not found." } };
    }
    if (!biddingOpen(match)) {
      markClean();
      const s = effectiveStatus(match);
      return { status: 409, body: { error:
        s === "live" ? "This match is live — bidding is closed."
        : s === "over" ? "This match is over — bidding is closed."
        : "Bidding is closed for this match." } };
    }
    if (db.bids.find((b) => b.matchId === match.id && b.email === email)) {
      markClean();
      return { status: 409, body: { error: "You already placed a bid on this match." } };
    }
    const balance = getBalance(db, email);
    if (amt > balance) {
      markClean();
      return { status: 400, body: { error: `Not enough balance. You have ₹${balance}.` } };
    }
    db.wallets[email] = balance - amt;
    db.bids.push({
      id: id(), matchId: match.id, gameId: match.gameId, email,
      outcome, stake: amt, ts: Date.now(), settled: false, payout: 0,
    });
    addOptIn(db, email);
    return {
      status: 201,
      body: { ok: true, balance: db.wallets[email] },
      broadcast: { event: "bids", data: { matchId: match.id, gameId: match.gameId } },
    };
  });
  if (out.broadcast) broadcast(out.broadcast.event, out.broadcast.data);
  res.status(out.status).json(out.body);
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
  const optedIn = await mutateDB(async (db) => {
    if (optIn) addOptIn(db, email); else removeOptIn(db, email);
    return isOptedIn(db, email);
  });
  res.json({ ok: true, optedIn });
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

// ---- User profiles & directory ----

// Public profile for any user by email. Anyone can view any profile.
app.get("/api/users/:email/profile", h(async (req, res) => {
  const email = auth.normalizeEmail(req.params.email);
  const db = await loadDB();
  // Only expose profiles for users who have actually logged in / registered.
  const known = (db.users || []).some((u) => u.email === email) ||
    (db.registrations || []).some((r) => r.email === email);
  if (!known) return res.status(404).json({ error: "User not found." });
  res.json(buildProfile(db, email));
}));

// The verified user's own profile.
app.post("/api/profile", h(async (req, res) => {
  const email = auth.verifySession((req.body || {}).sessionToken);
  if (!email) return res.status(401).json({ error: "Please verify your email to view your profile." });
  const db = await loadDB();
  // Self profile also includes the private wallet balance.
  res.json({ ...buildProfile(db, email), balance: getBalance(db, email) });
}));

// Directory of known users (for browsing profiles).
app.get("/api/users", h(async (req, res) => {
  const db = await loadDB();
  const list = (db.users || [])
    .map((u) => {
      const p = buildProfile(db, u.email);
      return {
        email: u.email, name: u.name,
        org: p.org, orgName: p.orgName,
        tournamentsParticipated: p.tournamentsParticipated,
        totalGamesWon: p.totalGamesWon,
        gamesPlayed: p.gamesPlayed,
        gamesWon: p.gamesWon,
      };
    })
    .sort((a, b) => b.gamesWon - a.gamesWon || b.tournamentsParticipated - a.tournamentsParticipated || a.name.localeCompare(b.name));
  res.json(list);
}));

// ---- Tournaments (public read + register/unregister) ----

app.get("/api/tournaments", h(async (req, res) => {
  const db = await loadDB();
  const list = (db.tournaments || [])
    .filter((t) => (t.status || "active") !== "archived")
    .map((t) => tournamentSummary(db, t))
    .sort((a, b) => {
      // Open registrations first, then upcoming, then closed; newest within each.
      const rank = { open: 0, upcoming: 1, closed: 2 };
      return (rank[a.registrationState] - rank[b.registrationState]) ||
        (b.createdAt - a.createdAt);
    });
  res.json(list);
}));

// Which tournaments the verified user is registered for: { ids: [...] }.
app.post("/api/tournaments/mine", h(async (req, res) => {
  const email = auth.verifySession((req.body || {}).sessionToken);
  if (!email) return res.json({ ids: [] });
  const db = await loadDB();
  const ids = (db.registrations || []).filter((r) => r.email === email).map((r) => r.tournamentId);
  res.json({ ids });
}));

app.get("/api/tournaments/:id", h(async (req, res) => {
  const db = await loadDB();
  const t = (db.tournaments || []).find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tournament not found." });
  const participants = (db.registrations || [])
    .filter((r) => r.tournamentId === t.id)
    .map((r) => ({
      email: r.email,
      name: displayName(db, r.email),
      registeredAt: r.registeredAt || 0,
      gamesWon: r.gamesWon || 0,
      position: r.position != null ? r.position : null,
    }))
    .sort((a, b) => {
      // Ranked participants first (by position), then the rest by name.
      if (a.position != null && b.position != null) return a.position - b.position;
      if (a.position != null) return -1;
      if (b.position != null) return 1;
      return a.name.localeCompare(b.name);
    });
  res.json({ ...tournamentSummary(db, t), participants });
}));

app.post("/api/tournaments/:id/register", h(async (req, res) => {
  const email = auth.verifySession((req.body || {}).sessionToken);
  if (!email) return res.status(401).json({ error: "Please verify your email before registering." });
  const out = await mutateDB(async (db) => {
    const t = (db.tournaments || []).find((x) => x.id === req.params.id);
    if (!t) { res.status(404).json({ error: "Tournament not found." }); return null; }
    if ((t.status || "active") === "archived") { res.status(409).json({ error: "This tournament is archived." }); return null; }
    const state = regState(t);
    if (state !== "open") {
      res.status(409).json({
        error: state === "upcoming"
          ? "Registration hasn't opened for this tournament yet."
          : "Registration for this tournament has closed.",
      });
      return null;
    }
    if (!orgEligible(t, email)) {
      res.status(403).json({
        error: `This tournament is only open to: ${tournamentSummary(db, t).orgsLabel}.`,
      });
      return null;
    }
    ensureUser(db, email);
    if (!db.registrations) db.registrations = [];
    if (db.registrations.some((r) => r.tournamentId === t.id && r.email === email)) {
      res.status(409).json({ error: "You're already registered for this tournament." });
      return null;
    }
    db.registrations.push({
      tournamentId: t.id, email, registeredAt: Date.now(), gamesWon: 0, position: null,
    });
    return tournamentSummary(db, t, email);
  });
  if (!out) return;
  broadcast("tournaments", { id: req.params.id });
  res.status(201).json({ ok: true, tournament: out });
}));

app.post("/api/tournaments/:id/unregister", h(async (req, res) => {
  const email = auth.verifySession((req.body || {}).sessionToken);
  if (!email) return res.status(401).json({ error: "Please verify your email first." });
  const out = await mutateDB(async (db) => {
    const t = (db.tournaments || []).find((x) => x.id === req.params.id);
    if (!t) { res.status(404).json({ error: "Tournament not found." }); return null; }
    const state = regState(t);
    if (state === "closed") {
      res.status(409).json({ error: "Registration has closed — you can no longer unregister." });
      return null;
    }
    if (!db.registrations) db.registrations = [];
    const before = db.registrations.length;
    db.registrations = db.registrations.filter(
      (r) => !(r.tournamentId === t.id && r.email === email)
    );
    if (db.registrations.length === before) {
      res.status(409).json({ error: "You're not registered for this tournament." });
      return null;
    }
    return tournamentSummary(db, t, email);
  });
  if (!out) return;
  broadcast("tournaments", { id: req.params.id });
  res.json({ ok: true, tournament: out });
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

app.post("/api/posts", writeLimiter, h(async (req, res) => {
  const { text, sessionToken, anonymous } = req.body || {};
  const email = auth.verifySession(sessionToken);
  if (!email) return res.status(401).json({ error: "Please verify your email before posting." });
  const body = String(text || "").trim();
  if (!body) return res.status(400).json({ error: "Post cannot be empty." });
  if (body.length > 500) return res.status(400).json({ error: "Post is too long (max 500 characters)." });
  const post = {
    id: id(), text: body, email, author: nameFromEmail(email),
    anonymous: !!anonymous, ts: Date.now(), status: "pending",
  };
  await mutateDB(async (db) => { db.posts.push(post); });
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
  await mutateDB(async (db) => {
    const post = db.posts.find((p) => p.id === req.params.postId);
    if (!post) return res.status(404).json({ error: "Post not found." });
    post.status = "approved";
    post.ts = Date.now();
    broadcast("posts", { approved: post.id });
    broadcast("moderation", { approved: post.id });
    res.json({ ok: true });
  });
}));

app.post("/api/admin/posts/:postId/reject", requireAdmin, h(async (req, res) => {
  await mutateDB(async (db) => {
    const before = db.posts.length;
    db.posts = db.posts.filter((p) => p.id !== req.params.postId);
    if (db.posts.length === before) return res.status(404).json({ error: "Post not found." });
    broadcast("moderation", { rejected: req.params.postId });
    res.json({ ok: true });
  });
}));

app.delete("/api/admin/posts/:postId", requireAdmin, h(async (req, res) => {
  await mutateDB(async (db) => {
    db.posts = db.posts.filter((p) => p.id !== req.params.postId);
    broadcast("posts", { deleted: req.params.postId });
    broadcast("moderation", { deleted: req.params.postId });
    res.json({ ok: true });
  });
}));

app.delete("/api/posts/:postId", h(async (req, res) => {
  const isAdmin = req.header("x-admin-key") === ADMIN_KEY;
  const requesterEmail = auth.verifySession((req.body || {}).sessionToken);
  await mutateDB(async (db) => {
    const post = db.posts.find((p) => p.id === req.params.postId);
    if (!post) return res.status(404).json({ error: "Post not found." });
    const isOwner = requesterEmail && requesterEmail === post.email;
    if (!isAdmin && !isOwner) return res.status(403).json({ error: "You can only delete your own posts." });
    db.posts = db.posts.filter((p) => p.id !== req.params.postId);
    broadcast("posts", { deleted: req.params.postId });
    broadcast("moderation", { deleted: req.params.postId });
    res.json({ ok: true });
  });
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

app.post("/api/chat", writeLimiter, h(async (req, res) => {
  const { text, sessionToken, gameId } = req.body || {};
  const email = auth.verifySession(sessionToken);
  if (!email) return res.status(401).json({ error: "Please verify your email before chatting." });
  if (!gameId) return res.status(400).json({ error: "gameId is required." });
  const body = String(text || "").trim();
  if (!body) return res.status(400).json({ error: "Message cannot be empty." });
  if (body.length > 500) return res.status(400).json({ error: "Message is too long (max 500 characters)." });
  const msg = { id: id(), gameId, text: body, email, author: nameFromEmail(email), ts: Date.now() };
  const sent = await mutateDB(async (db) => {
    if (!db.games.find((g) => g.id === gameId)) { res.status(404).json({ error: "Game not found." }); return false; }
    db.chat.push(msg);
    const gameMsgs = db.chat.filter((m) => m.gameId === gameId);
    if (gameMsgs.length > CHAT_LIMIT * 3) {
      const keepIds = new Set(gameMsgs.slice(-CHAT_LIMIT * 2).map((m) => m.id));
      db.chat = db.chat.filter((m) => m.gameId !== gameId || keepIds.has(m.id));
    }
    return true;
  });
  if (!sent) return;
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
  const isAdmin = req.header("x-admin-key") === ADMIN_KEY;
  const requesterEmail = auth.verifySession((req.body || {}).sessionToken);
  await mutateDB(async (db) => {
    const msg = db.chat.find((m) => m.id === req.params.msgId);
    if (!msg) return res.status(404).json({ error: "Message not found." });
    const isOwner = requesterEmail && requesterEmail === msg.email;
    if (!isAdmin && !isOwner) return res.status(403).json({ error: "You can only delete your own messages." });
    db.chat = db.chat.filter((m) => m.id !== req.params.msgId);
    broadcast("chat", { deleted: req.params.msgId, gameId: msg.gameId });
    res.json({ ok: true });
  });
}));

// ---------- Admin API ----------
app.post("/api/admin/verify", (req, res) => {
  const { key } = req.body || {};
  if (key === ADMIN_KEY) return res.json({ ok: true });
  res.status(401).json({ error: "Invalid admin key." });
});

// ---- Admin: allowed orgs (email domains) ----
app.get("/api/admin/orgs", requireAdmin, h(async (req, res) => {
  const domains = await loadAllowedDomains();
  res.json(domains.map(domainToOrg));
}));

app.post("/api/admin/orgs", requireAdmin, h(async (req, res) => {
  const domain = String((req.body || {}).domain || "").trim().toLowerCase();
  // Basic domain shape: something.tld, no spaces or @.
  if (!/^[^\s@]+\.[^\s@]+$/.test(domain)) {
    return res.status(400).json({ error: "Enter a valid email domain, e.g. acme.com" });
  }
  await pool.query("INSERT IGNORE INTO allowed_domains (domain) VALUES (?)", [domain]);
  const domains = await refreshAllowedDomains();
  console.log(`[config] allowed domain added: ${domain} (now: ${domains.join(", ") || "any"})`);
  res.status(201).json({ ok: true, orgs: domains.map(domainToOrg) });
}));

app.delete("/api/admin/orgs/:domain", requireAdmin, h(async (req, res) => {
  const domain = String(req.params.domain || "").trim().toLowerCase();
  await pool.query("DELETE FROM allowed_domains WHERE domain = ?", [domain]);
  const domains = await refreshAllowedDomains();
  console.log(`[config] allowed domain removed: ${domain} (now: ${domains.join(", ") || "any"})`);
  res.json({ ok: true, orgs: domains.map(domainToOrg) });
}));

// ---- Admin: wallets (add cash) ----
// List all users with their name, org and current balance.
app.get("/api/admin/wallets", requireAdmin, h(async (req, res) => {
  const db = await loadDB();
  const list = (db.users || [])
    .map((u) => ({ email: u.email, name: u.name, org: orgName(u.email), balance: getBalance(db, u.email) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(list);
}));

// Credit (or, with a negative amount, deduct) points to a user's wallet.
app.post("/api/admin/wallet/credit", requireAdmin, h(async (req, res) => {
  const { email, amount } = req.body || {};
  const addr = auth.normalizeEmail(email);
  const amt = Math.round(Number(amount));
  if (!addr) return res.status(400).json({ error: "Select a user." });
  if (!Number.isFinite(amt) || amt === 0) return res.status(400).json({ error: "Enter a non-zero whole amount." });
  const out = await mutateDB(async (db) => {
    const user = (db.users || []).find((u) => u.email === addr);
    if (!user) { res.status(404).json({ error: "User not found." }); return null; }
    const current = getBalance(db, addr);
    const next = current + amt;
    if (next < 0) {
      res.status(400).json({ error: `That would make the balance negative (current ₹${current}).` });
      return null;
    }
    db.wallets[addr] = next;
    return { email: addr, name: user.name, added: amt, balance: next };
  });
  if (!out) return;
  console.log(`[admin] wallet ${out.email} ${amt >= 0 ? "+" : ""}${amt} -> ₹${out.balance}`);
  res.json({ ok: true, ...out });
}));

// ---- Admin: games CRUD ----
app.post("/api/admin/games", requireAdmin, h(async (req, res) => {
  const { name, emoji, description } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Game name is required." });
  const game = { id: id(), name: name.trim(), emoji: (emoji || "\uD83C\uDFAE").trim(), description: (description || "").trim(), ts: Date.now() };
  await mutateDB(async (db) => { db.games.push(game); });
  broadcast("games", { id: game.id });
  res.status(201).json(game);
}));

app.put("/api/admin/games/:gameId", requireAdmin, h(async (req, res) => {
  const { name, emoji, description } = req.body || {};
  await mutateDB(async (db) => {
    const game = db.games.find((g) => g.id === req.params.gameId);
    if (!game) return res.status(404).json({ error: "Game not found." });
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: "Game name cannot be empty." });
      game.name = name.trim();
    }
    if (emoji !== undefined) game.emoji = (emoji || "\uD83C\uDFAE").trim();
    if (description !== undefined) game.description = description.trim();
    broadcast("games", { id: game.id });
    res.json({ ok: true, game });
  });
}));

app.delete("/api/admin/games/:gameId", requireAdmin, h(async (req, res) => {
  const gid = req.params.gameId;
  await mutateDB(async (db) => {
    if (!db.games.find((g) => g.id === gid)) return res.status(404).json({ error: "Game not found." });
    const matchIds = new Set(db.matches.filter((m) => m.gameId === gid).map((m) => m.id));
    db.games = db.games.filter((g) => g.id !== gid);
    db.matches = db.matches.filter((m) => m.gameId !== gid);
    db.bids = db.bids.filter((b) => !matchIds.has(b.matchId));
    db.chat = db.chat.filter((c) => c.gameId !== gid);
    broadcast("games", { deleted: gid });
    broadcast("matches", {});
    res.json({ ok: true });
  });
}));

// ---- Admin: tournaments CRUD + results ----
app.post("/api/admin/tournaments", requireAdmin, h(async (req, res) => {
  const { name, gameType, regStart, regEnd, orgs } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Tournament name is required." });
  const start = parseWhen(regStart);
  const end = parseWhen(regEnd);
  if (regStart && start == null) return res.status(400).json({ error: "Unparseable registration start time." });
  if (regEnd && end == null) return res.status(400).json({ error: "Unparseable registration end time." });
  if (start != null && end != null && end < start) {
    return res.status(400).json({ error: "Registration end must be after the start." });
  }
  const tournament = {
    id: id(), name: name.trim(), gameType: (gameType || "").trim(),
    regStart: start, regEnd: end, status: "active",
    orgs: sanitizeOrgs(orgs), createdAt: Date.now(),
  };
  await mutateDB(async (db) => {
    if (!db.tournaments) db.tournaments = [];
    db.tournaments.push(tournament);
  });
  broadcast("tournaments", { id: tournament.id });
  res.status(201).json(tournament);
}));

app.put("/api/admin/tournaments/:id", requireAdmin, h(async (req, res) => {
  const { name, gameType, regStart, regEnd, status, orgs } = req.body || {};
  await mutateDB(async (db) => {
    const t = (db.tournaments || []).find((x) => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: "Tournament not found." });
    if (orgs !== undefined) t.orgs = sanitizeOrgs(orgs);
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: "Tournament name cannot be empty." });
      t.name = name.trim();
    }
    if (gameType !== undefined) t.gameType = (gameType || "").trim();
    if (regStart !== undefined) {
      const s = parseWhen(regStart);
      if (regStart && s == null) return res.status(400).json({ error: "Unparseable registration start time." });
      t.regStart = s;
    }
    if (regEnd !== undefined) {
      const e = parseWhen(regEnd);
      if (regEnd && e == null) return res.status(400).json({ error: "Unparseable registration end time." });
      t.regEnd = e;
    }
    if (t.regStart != null && t.regEnd != null && t.regEnd < t.regStart) {
      return res.status(400).json({ error: "Registration end must be after the start." });
    }
    if (status !== undefined) {
      if (!["active", "archived"].includes(status)) return res.status(400).json({ error: "Invalid status." });
      t.status = status;
    }
    broadcast("tournaments", { id: t.id });
    res.json({ ok: true, tournament: t });
  });
}));

app.delete("/api/admin/tournaments/:id", requireAdmin, h(async (req, res) => {
  const tid = req.params.id;
  await mutateDB(async (db) => {
    if (!(db.tournaments || []).some((t) => t.id === tid)) return res.status(404).json({ error: "Tournament not found." });
    db.tournaments = (db.tournaments || []).filter((t) => t.id !== tid);
    db.registrations = (db.registrations || []).filter((r) => r.tournamentId !== tid);
    broadcast("tournaments", { deleted: tid });
    res.json({ ok: true });
  });
}));

// Record results: set gamesWon and/or final position per participant.
// Body: { results: [{ email, gamesWon, position }] }. Only updates existing
// registrations; unknown emails are reported as skipped.
app.post("/api/admin/tournaments/:id/results", requireAdmin, h(async (req, res) => {
  const results = ((req.body || {}).results) || [];
  if (!Array.isArray(results)) return res.status(400).json({ error: "results must be an array." });
  const out = await mutateDB(async (db) => {
    const t = (db.tournaments || []).find((x) => x.id === req.params.id);
    if (!t) { res.status(404).json({ error: "Tournament not found." }); return null; }
    let updated = 0;
    const skipped = [];
    for (const row of results) {
      const email = auth.normalizeEmail(row.email);
      const reg = (db.registrations || []).find((r) => r.tournamentId === t.id && r.email === email);
      if (!reg) { skipped.push(email); continue; }
      if (row.gamesWon !== undefined && row.gamesWon !== null && row.gamesWon !== "") {
        const gw = Math.floor(Number(row.gamesWon));
        reg.gamesWon = Number.isFinite(gw) && gw >= 0 ? gw : 0;
      }
      if (row.position !== undefined) {
        if (row.position === null || row.position === "") reg.position = null;
        else {
          const pos = Math.floor(Number(row.position));
          reg.position = Number.isFinite(pos) && pos >= 1 ? pos : null;
        }
      }
      updated += 1;
    }
    return { updated, skipped };
  });
  if (!out) return;
  broadcast("tournaments", { id: req.params.id });
  res.json({ ok: true, ...out });
}));

// Add a user to the match roster. The user MUST already exist (i.e. have
// verified their email / created an account). The roster entry ("player") is
// linked to that user by email so match results flow into their profile.
app.post("/api/admin/players", requireAdmin, h(async (req, res) => {
  const { email, org } = req.body || {};
  const addr = auth.normalizeEmail(email);
  if (!addr) return res.status(400).json({ error: "Select a user (email) to add." });
  const out = await mutateDB(async (db) => {
    const user = (db.users || []).find((u) => u.email === addr);
    if (!user) {
      res.status(400).json({ error: "That user doesn't exist yet. They must create an account (verify their email) first." });
      return null;
    }
    if ((db.players || []).some((p) => p.email === addr)) {
      res.status(409).json({ error: "That user is already on the roster." });
      return null;
    }
    const player = { id: id(), name: user.name, org: (org || "").trim(), email: addr };
    db.players.push(player);
    return player;
  });
  if (!out) return;
  broadcast("matches", {});
  res.status(201).json(out);
}));

app.delete("/api/admin/players/:playerId", requireAdmin, h(async (req, res) => {
  const pid = req.params.playerId;
  await mutateDB(async (db) => {
    const matchIds = new Set(db.matches.filter((m) => m.playerAId === pid || m.playerBId === pid).map((m) => m.id));
    db.players = db.players.filter((p) => p.id !== pid);
    db.matches = db.matches.filter((m) => m.playerAId !== pid && m.playerBId !== pid);
    db.bids = db.bids.filter((b) => !matchIds.has(b.matchId));
  });
  broadcast("matches", {});
  res.json({ ok: true });
}));

// Create a match UNDER a tournament, between two of its registered users.
// Body: { tournamentId, playerAEmail, playerBEmail, location, startAt, endAt }.
app.post("/api/admin/matches", requireAdmin, h(async (req, res) => {
  const { tournamentId, playerAEmail, playerBEmail, location, startAt, endAt } = req.body || {};
  const aEmail = auth.normalizeEmail(playerAEmail);
  const bEmail = auth.normalizeEmail(playerBEmail);
  if (!tournamentId) return res.status(400).json({ error: "Pick a tournament." });
  if (!aEmail || !bEmail) return res.status(400).json({ error: "Pick both players." });
  if (aEmail === bEmail) return res.status(400).json({ error: "A match needs two different players." });
  const out = await mutateDB(async (db) => {
    const t = (db.tournaments || []).find((x) => x.id === tournamentId);
    if (!t) { res.status(404).json({ error: "Tournament not found." }); return null; }
    const registered = (email) =>
      (db.registrations || []).some((r) => r.tournamentId === t.id && r.email === email);
    if (!registered(aEmail) || !registered(bEmail)) {
      res.status(400).json({ error: "Both players must be registered to this tournament first." });
      return null;
    }
    const game = ensureGameForTournament(db, t);
    const pa = ensurePlayerForUser(db, aEmail);
    const pb = ensurePlayerForUser(db, bEmail);
    const match = {
      id: id(), gameId: game.id, tournamentId: t.id,
      playerAId: pa.id, playerBId: pb.id,
      time: "", day: "Today", location: (location || "").trim(),
      status: "upcoming", result: null, winnerId: null,
      startAt: parseWhen(startAt), endAt: parseWhen(endAt),
    };
    db.matches.push(match);
    return match;
  });
  if (!out) return;
  broadcast("matches", { id: out.id, gameId: out.gameId });
  broadcast("games", {});
  res.status(201).json(out);
}));

// ---- Admin: bulk match upload (XLSX) ----
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Download a template .xlsx with the expected headers.
app.get("/api/admin/matches/template", (req, res) => {
  const headers = ["tournament", "gameType", "playerA_email", "playerB_email", "location", "startAt", "endAt"];
  const sample = [{
    tournament: "Spring Chess Cup", gameType: "Chess",
    playerA_email: "g.siva@unicommerce.com", playerB_email: "a.roy@snapdeal.com",
    location: "Sky Deck - Tower A", startAt: "2026-09-25 13:30",
    endAt: "", // optional — leave blank if the match has no fixed end time
  }];
  const ws = XLSX.utils.json_to_sheet(sample, { header: headers });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Matches");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Disposition", 'attachment; filename="snapgames-matches-template.xlsx"');
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
});

// Bulk upload. Each row is a match under a tournament between two users given
// by email. For every row we, in order:
//   1. create the users (pre-verified, no OTP) from their emails if missing,
//   2. register both to the tournament (auto-creating the tournament if needed),
//   3. create the match under that tournament.
// Best-effort: valid rows applied, bad rows skipped with a per-row reason.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  const result = await mutateDB(async (db) => {
    if (!db.tournaments) db.tournaments = [];
    if (!db.registrations) db.registrations = [];

    const tByName = {};
    db.tournaments.forEach((t) => (tByName[t.name.trim().toLowerCase()] = t));

    // Find or create a tournament by name (auto-created ones are open to all
    // orgs with no registration window).
    function ensureTournament(name, gameType) {
      const key = name.trim().toLowerCase();
      if (tByName[key]) {
        if (gameType && !tByName[key].gameType) tByName[key].gameType = gameType.trim();
        return tByName[key];
      }
      const t = {
        id: id(), name: name.trim(), gameType: (gameType || "").trim(),
        regStart: null, regEnd: null, status: "active", orgs: [], createdAt: Date.now(),
      };
      db.tournaments.push(t);
      tByName[key] = t;
      return t;
    }
    function register(t, email) {
      if (!db.registrations.some((r) => r.tournamentId === t.id && r.email === email)) {
        db.registrations.push({ tournamentId: t.id, email, registeredAt: Date.now(), gamesWon: 0, position: null });
        return true;
      }
      return false;
    }

    const report = [];
    let matchesCreated = 0, usersCreated = 0, registrationsCreated = 0;
    const tBefore = db.tournaments.length;
    const usersBefore = (db.users || []).length;

    rows.forEach((row, i) => {
      const rowNum = i + 2; // + header row, 1-indexed
      const tName = String(row.tournament || "").trim();
      const aEmail = auth.normalizeEmail(row.playerA_email);
      const bEmail = auth.normalizeEmail(row.playerB_email);
      if (!tName || !aEmail || !bEmail) {
        report.push({ row: rowNum, ok: false, error: "Missing tournament / playerA_email / playerB_email." });
        return;
      }
      if (!EMAIL_RE.test(aEmail) || !EMAIL_RE.test(bEmail)) {
        report.push({ row: rowNum, ok: false, error: "Invalid email address." });
        return;
      }
      if (aEmail === bEmail) {
        report.push({ row: rowNum, ok: false, error: "Player A and B must be different." });
        return;
      }
      const startAt = parseWhen(row.startAt);
      if (row.startAt && startAt == null) {
        report.push({ row: rowNum, ok: false, error: `Unparseable startAt "${row.startAt}" (use YYYY-MM-DD HH:MM).` });
        return;
      }
      const endAt = parseWhen(row.endAt);
      if (row.endAt && endAt == null) {
        report.push({ row: rowNum, ok: false, error: `Unparseable endAt "${row.endAt}".` });
        return;
      }

      const t = ensureTournament(tName, row.gameType);
      // Respect org scope on pre-existing, org-restricted tournaments.
      if (Array.isArray(t.orgs) && t.orgs.length) {
        const bad = [aEmail, bEmail].find((e) => !t.orgs.includes(auth.orgFromEmail(e)));
        if (bad) {
          report.push({ row: rowNum, ok: false, error: `${bad} is not in this tournament's allowed orgs (${t.orgs.join(", ")}).` });
          return;
        }
      }

      // 1) users (pre-verified) + wallet
      [aEmail, bEmail].forEach((e) => { ensureUser(db, e); getBalance(db, e); });
      // 2) register both
      if (register(t, aEmail)) registrationsCreated++;
      if (register(t, bEmail)) registrationsCreated++;
      // 3) match under the tournament
      const game = ensureGameForTournament(db, t);
      const pa = ensurePlayerForUser(db, aEmail);
      const pb = ensurePlayerForUser(db, bEmail);
      db.matches.push({
        id: id(), gameId: game.id, tournamentId: t.id,
        playerAId: pa.id, playerBId: pb.id,
        time: "", day: "Today", location: String(row.location || "").trim(),
        status: "upcoming", result: null, winnerId: null,
        startAt, endAt,
      });
      matchesCreated += 1;
      report.push({ row: rowNum, ok: true, match: `${t.name}: ${displayName(db, aEmail)} vs ${displayName(db, bEmail)}` });
    });

    usersCreated = (db.users || []).length - usersBefore;
    const tournamentsCreated = db.tournaments.length - tBefore;

    if (matchesCreated > 0) {
      broadcast("matches", {});
      broadcast("games", {});
      broadcast("tournaments", {});
    }
    return {
      ok: true,
      summary: {
        rows: rows.length, created: matchesCreated, skipped: rows.length - matchesCreated,
        usersCreated, tournamentsCreated, registrationsCreated,
      },
      report,
    };
  });
  res.json(result);
}));

app.delete("/api/admin/matches/:matchId", requireAdmin, h(async (req, res) => {
  const mid = req.params.matchId;
  await mutateDB(async (db) => {
    db.matches = db.matches.filter((m) => m.id !== mid);
    db.bids = db.bids.filter((b) => b.matchId !== mid);
  });
  broadcast("matches", { deleted: mid });
  res.json({ ok: true });
}));

// Set / update the result of a match (settles bids pari-mutuel).
app.post("/api/admin/matches/:matchId/winner", requireAdmin, h(async (req, res) => {
  const body = req.body || {};
  const result = body.result !== undefined ? body.result : body.winnerId;
  const out = await mutateDB(async (db, { markClean }) => {
    const match = db.matches.find((m) => m.id === req.params.matchId);
    if (!match) {
      markClean();
      return { status: 404, body: { error: "Match not found." } };
    }
    const val = result || null;
    if (val && val !== "draw" && val !== match.playerAId && val !== match.playerBId) {
      markClean();
      return { status: 400, body: { error: "Result must be one of the two players or a draw." } };
    }
    if (isDecided(match)) unsettleMatch(db, match); // reverse before re-applying
    match.result = val;
    match.winnerId = val && val !== "draw" ? val : null;
    if (val) match.status = "finished";
    else if (match.status === "finished") match.status = "upcoming";
    let settlement = null;
    let resultEmails = null;
    if (val) {
      settlement = settleMatch(db, match);
      // Email each bidder their result — but only ONCE (first settle), so
      // changing/correcting the result later doesn't re-spam everyone.
      if (!match.resultEmailedAt) {
        match.resultEmailedAt = Date.now();
        const pm = playerMap(db);
        const a = pm[match.playerAId] ? pm[match.playerAId].name : "Player A";
        const b = pm[match.playerBId] ? pm[match.playerBId].name : "Player B";
        const matchLine = `${a} vs ${b}`;
        const winOutcome = winningOutcome(match);
        const outLabel = winOutcome === "draw" ? "Draw"
          : winOutcome === "A" ? a : b;
        resultEmails = db.bids
          .filter((bd) => bd.matchId === match.id)
          .map((bd) => ({
            to: bd.email,
            won: (bd.payout || 0) > 0,
            stake: bd.stake,
            payout: bd.payout || 0,
            balance: db.wallets[bd.email],
            matchLine,
            outcomeLabel: bd.outcome === "draw" ? "Draw" : (bd.outcome === "A" ? a : b),
          }));
      }
    }
    return {
      status: 200,
      body: { ok: true, match, settlement },
      resultEmails,
      broadcasts: [
        { event: "winner", data: { matchId: match.id, result: match.result } },
        { event: "bids", data: { matchId: match.id, gameId: match.gameId } },
        { event: "matches", data: { id: match.id } },
      ],
    };
  });
  if (out.broadcasts) out.broadcasts.forEach((b) => broadcast(b.event, b.data));
  // Fire-and-forget the result emails AFTER the DB write is committed.
  if (out.resultEmails && out.resultEmails.length) {
    sendBetResultEmails(out.resultEmails).catch((e) =>
      console.error("[bet-result email] error:", e.message)
    );
  }
  res.status(out.status).json(out.body);
}));

// Set live/upcoming/over status (does not affect result).
app.post("/api/admin/matches/:matchId/status", requireAdmin, h(async (req, res) => {
  const { status } = req.body || {};
  if (!["upcoming", "live", "over"].includes(status)) {
    return res.status(400).json({ error: "Status must be 'upcoming', 'live', or 'over'." });
  }
  await mutateDB(async (db) => {
    const match = db.matches.find((m) => m.id === req.params.matchId);
    if (!match) return res.status(404).json({ error: "Match not found." });
    if (isDecided(match)) {
      return res.status(409).json({ error: "This match is finished (has a result). Clear the result first to change status." });
    }
    const wasLive = match.status === "live";
    match.status = status;
    broadcast("matches", { id: match.id });
    let notify = null;
    if (status === "live" && !wasLive) {
      const baseUrl = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
      notifyMatchLive(db, match, baseUrl).catch((e) => console.error("[notify] error:", e.message));
      notify = { queued: true, recipients: db.notifyOptIns.length };
    }
    res.json({ ok: true, match, notify });
  });
}));

// ---------- Keep-alive (prevent free-tier idle spin-down) ----------
// Pings our own public URL on an interval so the host (e.g. Render free tier)
// sees inbound traffic and doesn't sleep after ~15 min idle. Only runs when
// PUBLIC_URL is set (i.e. in production), never locally.
// ponytail: in-process self-ping. Ceiling: if the service ever DOES spin down
// (crash/restart during a traffic lull) the timer dies with it and won't wake
// itself — pair with an external uptime pinger (cron-job.org / UptimeRobot)
// hitting PUBLIC_URL for a robust guarantee.
const KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000; // 10 min (< the 15 min idle window)
function startKeepAlive() {
  const url = process.env.PUBLIC_URL;
  if (!url) {
    console.log("[keepalive] disabled (PUBLIC_URL not set)");
    return;
  }
  const client = url.startsWith("https") ? require("https") : require("http");
  setInterval(() => {
    const started = Date.now();
    const req = client.get(url, (res) => {
      res.resume(); // drain
      console.log(`[keepalive] ping ${url} -> ${res.statusCode} (${Date.now() - started}ms)`);
    });
    req.on("error", (e) => console.error("[keepalive] ping failed:", e.message));
    req.setTimeout(15000, () => req.destroy(new Error("timeout")));
  }, KEEP_ALIVE_INTERVAL_MS);
  console.log(`[keepalive] enabled, pinging ${url} every ${KEEP_ALIVE_INTERVAL_MS / 60000} min`);
}

// ---------- Startup ----------

// Lightweight migration: add any columns the code expects but an older
// deployed DB may lack. CREATE TABLE IF NOT EXISTS does NOT add columns to an
// existing table, so column additions (e.g. resultEmailedAt) must be applied
// here — otherwise saveDB's INSERT fails and every write returns 500.
async function ensureColumns() {
  const wanted = [
    { table: "matches", column: "startAt", ddl: "BIGINT DEFAULT NULL" },
    { table: "matches", column: "endAt", ddl: "BIGINT DEFAULT NULL" },
    { table: "matches", column: "resultEmailedAt", ddl: "BIGINT DEFAULT NULL" },
  ];
  for (const w of wanted) {
    try {
      const [rows] = await pool.query(
        "SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
        [w.table, w.column]
      );
      if (rows[0].c === 0) {
        await pool.query(`ALTER TABLE \`${w.table}\` ADD COLUMN \`${w.column}\` ${w.ddl}`);
        console.log(`[migrate] added ${w.table}.${w.column}`);
      }
    } catch (e) {
      console.error(`[migrate] ${w.table}.${w.column} failed:`, e.message);
    }
  }
}

(async () => {
  try {
    await ensureSchema();          // create/alter tables & feature columns
    await ensureColumns();         // add resultEmailedAt (+ startAt/endAt) on old DBs
    await seedAllowedDomainsOnce();
    await refreshAllowedDomains();
    await seedIfEmpty();
  } catch (e) {
    console.error("[startup] schema/seed error:", e.message);
    console.error("Ensure MySQL is reachable and the DB user can CREATE/ALTER, or load schema.sql manually.");
  }
  auth.verifySmtp(); // log SMTP status at boot (helps diagnose missing OTPs)
  startKeepAlive();
  app.listen(PORT, () => {
    console.log(`SnapGames server running at http://localhost:${PORT}`);
  });
})();
