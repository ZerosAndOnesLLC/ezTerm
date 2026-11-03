-- Persistent remote sessions + auto-reconnect (SSH only).
--
--   * persistent_shell: 'off' | 'tmux' | 'screen'. When not 'off', the SSH
--     connect flow runs the interactive shell inside a remote tmux/screen
--     session named `ezterm-<session_id>-<tab slot>` and reattaches to it
--     on reconnect. Falls back to a plain shell if the tool is missing.
--   * auto_reconnect: 0/1. Reconnect automatically (with backoff) when the
--     transport drops without an exit status.
--
-- Allowed values are enforced by the Rust validator; wsl/local rows must
-- keep the defaults.
ALTER TABLE sessions ADD COLUMN persistent_shell TEXT NOT NULL DEFAULT 'off';
ALTER TABLE sessions ADD COLUMN auto_reconnect   INTEGER NOT NULL DEFAULT 0;
