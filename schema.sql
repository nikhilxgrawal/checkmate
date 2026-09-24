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
  org VARCHAR(255) DEFAULT ''
);

CREATE TABLE IF NOT EXISTS matches (
  id VARCHAR(32) PRIMARY KEY,
  gameId VARCHAR(32) NOT NULL,
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
