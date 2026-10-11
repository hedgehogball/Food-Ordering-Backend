-- MySQL 5.7 / 8.0. Select an existing, dedicated database before running.
-- Existing installations are upgraded by src/database.js initialize().
-- This file never deletes tables or business data.
CREATE TABLE IF NOT EXISTS lj_dining_tables (
  id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  document JSON NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS lj_dining_sessions (
  id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  document JSON NOT NULL,
  created_at BIGINT GENERATED ALWAYS AS
    (CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(document,'$.createdAt')),'null') AS UNSIGNED)) STORED,
  updated_at BIGINT GENERATED ALWAYS AS
    (CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(document,'$.updatedAt')),'null') AS UNSIGNED)) STORED,
  paid_at BIGINT GENERATED ALWAYS AS
    (CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(document,'$.checkout.paidAt')),'null') AS UNSIGNED)) STORED,
  KEY report_created_at (created_at),
  KEY report_updated_at (updated_at),
  KEY report_paid_at (paid_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS lj_users (
  id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  first_seen BIGINT NOT NULL,
  last_seen BIGINT NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS lj_takeaway (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  actor CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at BIGINT NOT NULL,
  document JSON NOT NULL,
  paid_at BIGINT GENERATED ALWAYS AS
    (CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(document,'$.order.settledAt')),'null') AS UNSIGNED)) STORED,
  UNIQUE KEY request_once (actor,request_id),
  KEY user_history (actor,created_at),
  KEY report_paid_at (paid_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS lj_settings (
  id VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  document JSON NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS lj_print_jobs (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  source_key VARCHAR(200) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at BIGINT NOT NULL,
  document JSON NOT NULL,
  UNIQUE KEY source_once (source_key),
  KEY queue_status (status,created_at)
) ENGINE=InnoDB;
