-- Session kind: ssh | wsl | local.
--
-- For ssh rows, the existing columns keep their meanings (host/port/username).
-- For wsl rows:   host = distro name, username = optional wsl user, port unused.
-- For local rows: host = shell program ('cmd', 'pwsh', 'powershell'),
--                  username = optional starting directory, port unused.
-- auth_type/credential_id are forced to 'agent'/NULL for wsl and local by the
-- command-layer validator — no DB CHECK since sqlx migrate + older SQLite
-- versions on user machines can be fussy about adding constraints post-hoc.

ALTER TABLE sessions
  ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'ssh';
