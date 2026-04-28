-- Per-session font family. Empty string means "use the app default"
-- (the Cascadia Mono stack baked into lib/xterm.ts) so pre-existing
-- rows keep today's look without a data migration.
ALTER TABLE sessions ADD COLUMN font_family TEXT NOT NULL DEFAULT '';
