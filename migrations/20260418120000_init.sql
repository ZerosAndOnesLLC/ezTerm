PRAGMA foreign_keys = ON;

CREATE TABLE folders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id  INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    sort       INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_folders_parent ON folders(parent_id);

CREATE TABLE credentials (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT    NOT NULL CHECK (kind IN ('password','private_key','key_passphrase')),
    label      TEXT    NOT NULL,
    nonce      BLOB    NOT NULL,
    ciphertext BLOB    NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id     INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    name          TEXT    NOT NULL,
    host          TEXT    NOT NULL,
    port          INTEGER NOT NULL DEFAULT 22,
    username      TEXT    NOT NULL,
    auth_type     TEXT    NOT NULL CHECK (auth_type IN ('password','key','agent')),
    credential_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL,
    color         TEXT,
    sort          INTEGER NOT NULL DEFAULT 0,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_sessions_folder ON sessions(folder_id);
CREATE INDEX idx_sessions_credential ON sessions(credential_id);

CREATE TRIGGER trg_sessions_updated_at
AFTER UPDATE ON sessions
FOR EACH ROW
BEGIN
    UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;

CREATE TABLE known_hosts (
    host        TEXT    NOT NULL,
    port        INTEGER NOT NULL,
    key_type    TEXT    NOT NULL,
    fingerprint TEXT    NOT NULL,
    first_seen  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (host, port, key_type)
);

CREATE TABLE vault_meta (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    salt       BLOB NOT NULL,
    kdf_params TEXT NOT NULL,
    verifier   BLOB NOT NULL
);

CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
