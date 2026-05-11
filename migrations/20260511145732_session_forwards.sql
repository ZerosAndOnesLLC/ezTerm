-- Persistent SSH port forwards. One row per configured forward; auto-start
-- runs at the end of ssh::connect_impl for any row with auto_start = 1.
-- ON DELETE CASCADE removes forwards when their session row is deleted.
--
-- For kind='dynamic' the dest_addr/dest_port columns are stored as ''/0
-- (the destination is chosen per-connection by the SOCKS5 client).
-- Rust-side validation in db::forwards enforces the per-kind shape.

CREATE TABLE session_forwards (
  id           INTEGER PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL CHECK (kind IN ('local','remote','dynamic')),
  bind_addr    TEXT NOT NULL DEFAULT '127.0.0.1',
  bind_port    INTEGER NOT NULL CHECK (bind_port BETWEEN 1 AND 65535),
  dest_addr    TEXT NOT NULL DEFAULT '',
  dest_port    INTEGER NOT NULL DEFAULT 0,
  auto_start   INTEGER NOT NULL DEFAULT 1,
  sort         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_session_forwards_session
  ON session_forwards(session_id, sort);
