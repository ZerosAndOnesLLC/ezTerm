-- Auto-detected WSL/Local Shells sessions used to be tagged with the
-- emerald-400 colour (#34d399), which painted both the 3px left rail and
-- the icon tile green in the sessions sidebar. The autodetect paths no
-- longer set that colour; this migration clears it from existing rows so
-- the sidebar matches the new behaviour without requiring users to edit
-- each session by hand.
UPDATE sessions
SET color = NULL
WHERE color = '#34d399'
  AND session_kind IN ('wsl', 'local');
