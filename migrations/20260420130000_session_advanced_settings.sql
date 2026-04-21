-- Per-session advanced settings (v0.5).
--
-- Defaults are chosen to match current hard-coded behaviour so existing rows
-- behave identically after the migration:
--   * scrollback 5000 lines, 13px block cursor — matches `createTerminal()`.
--   * keepalive 0 (disabled) — russh's current default is no keepalives.
--   * compression off — russh 0.45 advertises it only when we opt in.
--   * connect_timeout 15s — same order of magnitude as the 30s ssh-agent
--     fallback already in client.rs.
--
-- cursor_style is a string enum for readability over an int. Range limits
-- (scrollback 1..100_000, font_size 8..48, keepalive 0..7200,
-- connect_timeout 1..600) are enforced in the Rust validator, not here — SQL
-- CHECKs are easy to forget to update and the Rust layer is the single
-- source of truth for input validation.
ALTER TABLE sessions ADD COLUMN initial_command       TEXT;
ALTER TABLE sessions ADD COLUMN scrollback_lines      INTEGER NOT NULL DEFAULT 5000;
ALTER TABLE sessions ADD COLUMN font_size             INTEGER NOT NULL DEFAULT 13;
ALTER TABLE sessions ADD COLUMN cursor_style          TEXT    NOT NULL DEFAULT 'block'
    CHECK (cursor_style IN ('block','bar','underline'));
ALTER TABLE sessions ADD COLUMN compression           INTEGER NOT NULL DEFAULT 0
    CHECK (compression IN (0,1));
ALTER TABLE sessions ADD COLUMN keepalive_secs        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN connect_timeout_secs  INTEGER NOT NULL DEFAULT 15;

-- Environment variables passed via SSH `env` requests (channel.set_env) at
-- connect time. Kept in a child table so a session can have 0..N pairs
-- without wide JSON columns or sparse joins. Composite PK doubles as the
-- unique-key index; no other access pattern queries by value alone.
CREATE TABLE session_env (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    key        TEXT    NOT NULL,
    value      TEXT    NOT NULL,
    PRIMARY KEY (session_id, key)
);
