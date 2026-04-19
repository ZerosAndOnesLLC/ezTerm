-- Add SHA-256 fingerprint alongside the existing free-form fingerprint column.
-- Older rows keep the TEXT fingerprint; new rows populate both until a future
-- cleanup migration drops the original column.
ALTER TABLE known_hosts ADD COLUMN fingerprint_sha256 TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_known_hosts_host_port ON known_hosts(host, port);
