-- SnapGames schema. Run once:  mysql -u root -p < schema.sql
CREATE DATABASE IF NOT EXISTS checkmate CHARACTER SET utf8mb4;
USE checkmate;

CREATE TABLE IF NOT EXISTS games (
  id VARCHAR(32) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  emoji VARCHAR(16) DEFAULT '🎮',
  description VARCHAR(500) DEFAULT '',
  ts BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  id VARCHAR(32) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  org VARCHAR(255) DEFAULT '',
  email VARCHAR(255) DEFAULT NULL   -- links this roster entry to a verified user (users.email)
);

CREATE TABLE IF NOT EXISTS matches (
  id VARCHAR(32) PRIMARY KEY,
  gameId VARCHAR(32) NOT NULL,
  tournamentId VARCHAR(32) DEFAULT NULL,   -- the tournament this match belongs to
  playerAId VARCHAR(32) NOT NULL,
  playerBId VARCHAR(32) NOT NULL,
  time VARCHAR(255) DEFAULT '',
  day VARCHAR(64) DEFAULT 'Today',
  location VARCHAR(255) DEFAULT '',
  status VARCHAR(16) DEFAULT 'upcoming',  -- 'upcoming' | 'live' | 'over' | 'finished'
  result VARCHAR(32) DEFAULT NULL,        -- 'draw' | playerId | NULL
  winnerId VARCHAR(32) DEFAULT NULL,      -- legacy, kept in sync with result
  startAt BIGINT DEFAULT NULL,            -- epoch ms; auto-go-live at this time
  endAt BIGINT DEFAULT NULL,              -- epoch ms; auto-mark 'over' at this time
  resultEmailedAt BIGINT DEFAULT NULL     -- epoch ms; set once bidder result emails sent
);

-- Pari-mutuel bids. One bid per (matchId, email). outcome is 'A' | 'B' | 'draw'.
-- stake = points wagered (1..20). settled/payout filled in on match settlement.
CREATE TABLE IF NOT EXISTS bids (
  id VARCHAR(32) PRIMARY KEY,
  matchId VARCHAR(32) NOT NULL,
  gameId VARCHAR(32) NOT NULL,
  email VARCHAR(255) NOT NULL,
  outcome VARCHAR(8) NOT NULL,            -- 'A' | 'B' | 'draw'
  stake INT NOT NULL,                     -- 1..20
  ts BIGINT NOT NULL,
  settled TINYINT(1) NOT NULL DEFAULT 0,
  payout INT NOT NULL DEFAULT 0,
  UNIQUE KEY uniq_match_email (matchId, email)
);

CREATE TABLE IF NOT EXISTS wallets (
  email VARCHAR(255) PRIMARY KEY,
  balance INT NOT NULL DEFAULT 1000
);

CREATE TABLE IF NOT EXISTS posts (
  id VARCHAR(32) PRIMARY KEY,
  text VARCHAR(500) NOT NULL,
  email VARCHAR(255) NOT NULL,
  author VARCHAR(255) NOT NULL,
  anonymous TINYINT(1) DEFAULT 0,
  ts BIGINT NOT NULL,
  status VARCHAR(16) DEFAULT 'pending'    -- 'pending' | 'approved'
);

CREATE TABLE IF NOT EXISTS chat (
  id VARCHAR(32) PRIMARY KEY,
  gameId VARCHAR(32) NOT NULL,
  text VARCHAR(500) NOT NULL,
  email VARCHAR(255) NOT NULL,            -- internal only, for own-delete auth
  author VARCHAR(255) NOT NULL,
  ts BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS notify_optins (
  email VARCHAR(255) PRIMARY KEY
);

-- Authenticated user profiles. One row per verified email. Created/updated on
-- OTP verification. `name` defaults to a title-cased version of the email local
-- part but is stored so it can be edited later.
CREATE TABLE IF NOT EXISTS users (
  email VARCHAR(255) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  createdAt BIGINT NOT NULL
);

-- Admin-created tournaments. Users may register/unregister only while
-- now() is within [regStart, regEnd]. gameType is a free-text game name
-- (typically chosen from the existing games list on the frontend).
CREATE TABLE IF NOT EXISTS tournaments (
  id VARCHAR(32) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  gameType VARCHAR(255) NOT NULL DEFAULT '',
  regStart BIGINT DEFAULT NULL,          -- epoch ms; registration opens
  regEnd BIGINT DEFAULT NULL,            -- epoch ms; registration closes
  status VARCHAR(16) NOT NULL DEFAULT 'active',  -- 'active' | 'archived'
  orgs VARCHAR(500) NOT NULL DEFAULT '', -- comma-separated org ids allowed to register; empty = all orgs
  createdAt BIGINT NOT NULL
);

-- One registration per (tournamentId, email). gamesWon and position are
-- filled in by an admin recording results (position = final rank, NULL until set).
CREATE TABLE IF NOT EXISTS tournament_registrations (
  tournamentId VARCHAR(32) NOT NULL,
  email VARCHAR(255) NOT NULL,
  registeredAt BIGINT NOT NULL,
  gamesWon INT NOT NULL DEFAULT 0,
  position INT DEFAULT NULL,
  PRIMARY KEY (tournamentId, email)
);

-- Allowed email domains (each domain's first label is an "org"). Managed from
-- the admin panel. Seeded once from ALLOWED_EMAIL_DOMAINS on first boot.
CREATE TABLE IF NOT EXISTS allowed_domains (
  domain VARCHAR(255) PRIMARY KEY
);

-- Small key/value store for app bookkeeping (e.g. one-time seed markers).
CREATE TABLE IF NOT EXISTS app_meta (
  k VARCHAR(64) PRIMARY KEY,
  v TEXT
);
