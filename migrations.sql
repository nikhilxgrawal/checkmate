-- migrations.sql — upgrade an EXISTING SnapGames database to the current schema.
--
-- Use this for a database created before the user-profiles / tournaments /
-- org / allowed-domains features. It is IDEMPOTENT — safe to run more than once.
--
-- Run against the target database, e.g.:
--     mysql -u <user> -p checkmate < migrations.sql
--
-- NOTE: the app also applies all of this automatically at startup
-- (ensureSchema() in server.js). Run this file manually only when the app's DB
-- user cannot execute DDL (CREATE/ALTER). A fresh install should use schema.sql.

-- 1) New tables (CREATE ... IF NOT EXISTS is naturally idempotent) -------------

CREATE TABLE IF NOT EXISTS users (
  email VARCHAR(255) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  createdAt BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS tournaments (
  id VARCHAR(32) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  gameType VARCHAR(255) NOT NULL DEFAULT '',
  regStart BIGINT DEFAULT NULL,
  regEnd BIGINT DEFAULT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  orgs VARCHAR(500) NOT NULL DEFAULT '',
  createdAt BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS tournament_registrations (
  tournamentId VARCHAR(32) NOT NULL,
  email VARCHAR(255) NOT NULL,
  registeredAt BIGINT NOT NULL,
  gamesWon INT NOT NULL DEFAULT 0,
  position INT DEFAULT NULL,
  PRIMARY KEY (tournamentId, email)
);

CREATE TABLE IF NOT EXISTS allowed_domains (
  domain VARCHAR(255) PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS app_meta (
  k VARCHAR(64) PRIMARY KEY,
  v TEXT
);

-- 2) New columns on existing tables -------------------------------------------
-- MySQL has no portable "ADD COLUMN IF NOT EXISTS", so we add each column only
-- when it's missing, via a temporary stored procedure. This keeps re-runs safe.

DELIMITER $$
DROP PROCEDURE IF EXISTS sg_add_column $$
CREATE PROCEDURE sg_add_column(IN tbl VARCHAR(64), IN col VARCHAR(64), IN ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col
  ) THEN
    SET @sg_ddl = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN ', ddl);
    PREPARE sg_stmt FROM @sg_ddl;
    EXECUTE sg_stmt;
    DEALLOCATE PREPARE sg_stmt;
  END IF;
END $$
DELIMITER ;

CALL sg_add_column('players',     'email',        "email VARCHAR(255) DEFAULT NULL");
CALL sg_add_column('matches',     'tournamentId', "tournamentId VARCHAR(32) DEFAULT NULL");
CALL sg_add_column('tournaments', 'orgs',         "orgs VARCHAR(500) NOT NULL DEFAULT ''");

DROP PROCEDURE IF EXISTS sg_add_column;

-- If your MySQL variant doesn't support stored procedures (e.g. some TiDB
-- versions), run these three plain statements ONCE instead of the block above
-- (each errors harmlessly if the column already exists):
--   ALTER TABLE players     ADD COLUMN email VARCHAR(255) DEFAULT NULL;
--   ALTER TABLE matches     ADD COLUMN tournamentId VARCHAR(32) DEFAULT NULL;
--   ALTER TABLE tournaments ADD COLUMN orgs VARCHAR(500) NOT NULL DEFAULT '';
