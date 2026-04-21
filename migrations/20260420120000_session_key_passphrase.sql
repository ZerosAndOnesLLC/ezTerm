-- Optional credential that holds the passphrase for a passphrase-protected
-- private key. Separate column from `credential_id` (which holds the private
-- key itself) because the two are distinct secrets stored as two rows in
-- `credentials` with kinds 'private_key' and 'key_passphrase' respectively.
-- ON DELETE SET NULL mirrors the behaviour of `credential_id` so deleting a
-- stored passphrase does not cascade-delete the session.
ALTER TABLE sessions
    ADD COLUMN key_passphrase_credential_id INTEGER
        REFERENCES credentials(id) ON DELETE SET NULL;

CREATE INDEX idx_sessions_key_passphrase ON sessions(key_passphrase_credential_id);
