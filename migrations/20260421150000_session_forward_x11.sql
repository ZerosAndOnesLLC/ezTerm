-- Per-session X11 forwarding toggle. When enabled on an SSH session,
-- the connect flow asks russh for X11 forwarding and ezTerm starts a
-- VcXsrv display locally to receive the forwarded GUI apps.
--
-- Stored as INTEGER (0/1) because SQLite has no native bool.
-- Only meaningful for session_kind='ssh'; wsl/local rows ignore it.

ALTER TABLE sessions
  ADD COLUMN forward_x11 INTEGER NOT NULL DEFAULT 0;
