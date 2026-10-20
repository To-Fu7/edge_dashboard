-- Edge schema, version 1. Applied by the dashboard (role edge_owner) at startup.
-- Roles and the `edge` database itself are created by setup/install.sh.

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid() on PostgreSQL < 13

-- ---------------------------------------------------------------- auth ----
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL UNIQUE CHECK (username ~ '^[A-Za-z0-9._-]{1,64}$'),
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,               -- sha256 of the random session token
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  user_agent  TEXT,
  ip          TEXT
);
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

-- ------------------------------------------------------------ settings ----
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE settings_history (
  id         BIGSERIAL PRIMARY KEY,
  key        TEXT NOT NULL,
  value      JSONB NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by UUID REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX idx_settings_history_key ON settings_history (key, changed_at DESC);

-- ------------------------------------------------------------- devices ----
CREATE TABLE devices (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code           TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9_-]{1,64}$'),
  name           TEXT NOT NULL,
  enabled        BOOLEAN NOT NULL DEFAULT false,   -- desired state: container should be running
  overrides      JSONB NOT NULL DEFAULT '{}',      -- only values that differ from the inherited ones
  effective_env  JSONB NOT NULL DEFAULT '{}',      -- what the camera container loads (computed by the dashboard)
  config_version INTEGER NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE device_config_history (
  id             BIGSERIAL PRIMARY KEY,
  device_id      UUID NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  config_version INTEGER NOT NULL,
  code           TEXT NOT NULL,
  name           TEXT NOT NULL,
  overrides      JSONB NOT NULL,
  reason         TEXT NOT NULL,                    -- 'device', 'settings', 'rollback', 'create', 'import'
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by     UUID REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX idx_device_config_history_device ON device_config_history (device_id, changed_at DESC);

CREATE TABLE device_status (
  device_id      UUID PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
  state          TEXT NOT NULL,                    -- starting | running | degraded | error | stopping
  fps            REAL,
  persons        REAL,                             -- tracked persons per frame (avg over the last interval)
  in_today       INTEGER,
  out_today      INTEGER,
  config_version INTEGER,
  triton_ok      BOOLEAN,
  last_error     TEXT,
  details        JSONB NOT NULL DEFAULT '{}',
  started_at     TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE port_forwards (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  device_id   UUID REFERENCES devices (id) ON DELETE CASCADE,   -- NULL = manual target
  src_ip      TEXT NOT NULL,
  src_port    INTEGER NOT NULL CHECK (src_port BETWEEN 1 AND 65535),
  listen_port INTEGER NOT NULL UNIQUE,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------- results ----
-- Same shapes as python-counting's former init_db.py.
CREATE TABLE person_inout (
  id         UUID PRIMARY KEY,
  device_id  UUID NOT NULL,
  total_in   INTEGER NOT NULL DEFAULT 0,
  total_out  INTEGER NOT NULL DEFAULT 0,
  data       JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_person_inout_device_time ON person_inout (device_id, created_at DESC);

CREATE TABLE inout_resample (
  id           SERIAL PRIMARY KEY,
  device_id    UUID NOT NULL,
  device_name  TEXT,
  device_code  TEXT,
  interval_in  INTEGER NOT NULL DEFAULT 0,
  interval_out INTEGER NOT NULL DEFAULT 0,
  hour_start   TIMESTAMPTZ NOT NULL,          -- stored in UTC
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_synced    BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (device_id, hour_start)
);
CREATE INDEX idx_inout_resample_unsynced ON inout_resample (hour_start) WHERE is_synced = false;

CREATE TABLE apd_hourly (
  device_id   UUID NOT NULL,
  device_code TEXT NOT NULL,
  device_name TEXT,
  hour_start  TIMESTAMPTZ NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_synced   BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (device_id, hour_start)
);
CREATE TABLE firesmoke_hourly (LIKE apd_hourly INCLUDING ALL);
CREATE TABLE face_hourly      (LIKE apd_hourly INCLUDING ALL);
CREATE TABLE intrusion_hourly (LIKE apd_hourly INCLUDING ALL);
CREATE INDEX idx_apd_hourly_device_time       ON apd_hourly       (device_id, hour_start DESC);
CREATE INDEX idx_firesmoke_hourly_device_time ON firesmoke_hourly (device_id, hour_start DESC);
CREATE INDEX idx_face_hourly_device_time      ON face_hourly      (device_id, hour_start DESC);
CREATE INDEX idx_intrusion_hourly_device_time ON intrusion_hourly (device_id, hour_start DESC);
CREATE INDEX idx_apd_hourly_unsynced       ON apd_hourly       (hour_start) WHERE is_synced = false;
CREATE INDEX idx_firesmoke_hourly_unsynced ON firesmoke_hourly (hour_start) WHERE is_synced = false;
CREATE INDEX idx_face_hourly_unsynced      ON face_hourly      (hour_start) WHERE is_synced = false;
CREATE INDEX idx_intrusion_hourly_unsynced ON intrusion_hourly (hour_start) WHERE is_synced = false;

CREATE TABLE known_faces (
  id                UUID PRIMARY KEY,
  person_name       TEXT NOT NULL,
  embedding         REAL[] NOT NULL,
  source_photo_path TEXT,
  variant_type      TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_known_faces_person ON known_faces (person_name);

-- ---------------------------------------------------- camera role grants ----
-- edge_device can read only the columns it needs from devices (no overrides,
-- no other tables' configuration), write its own results and heartbeat, and
-- read the face roster. It can't touch users, sessions, settings or history.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_device') THEN
    GRANT USAGE ON SCHEMA public TO edge_device;
    GRANT SELECT (id, code, name, enabled, effective_env, config_version) ON devices TO edge_device;
    GRANT SELECT, INSERT, UPDATE ON person_inout, inout_resample, apd_hourly, firesmoke_hourly,
      face_hourly, intrusion_hourly, device_status TO edge_device;
    GRANT USAGE ON SEQUENCE inout_resample_id_seq TO edge_device;
    GRANT SELECT ON known_faces TO edge_device;
  END IF;
END $$;
