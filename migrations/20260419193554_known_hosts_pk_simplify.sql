-- Simplify known_hosts PK to (host, port). key_type becomes informational.
-- Rationale: audit found ambiguous TOFU semantics when key_type varied across
-- re-connects. The (host, port) PK matches how check_known_host actually queries.
CREATE TABLE known_hosts_new (
    host               TEXT    NOT NULL,
    port               INTEGER NOT NULL,
    key_type           TEXT    NOT NULL,
    fingerprint        TEXT    NOT NULL,
    fingerprint_sha256 TEXT    NOT NULL DEFAULT '',
    first_seen         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (host, port)
);

INSERT OR IGNORE INTO known_hosts_new (host, port, key_type, fingerprint, fingerprint_sha256, first_seen)
SELECT host, port, key_type, fingerprint, fingerprint_sha256, first_seen FROM known_hosts;

DROP TABLE known_hosts;
ALTER TABLE known_hosts_new RENAME TO known_hosts;

-- PK (host, port) already covers host-prefix lookups; drop the old redundant index.
DROP INDEX IF EXISTS idx_known_hosts_host_port;
